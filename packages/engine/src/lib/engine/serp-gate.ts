// The SERP-strength gate. Before a topic is written, look at the current top 10 for its target query. If more than half of
// the ranking domains are strong (see src/config/serp-gate.ts for what strong means), skip the topic and log why.
// A new domain cannot win a results page full of G2, Capterra and the competitor's own site, so writing for it only spends the quota.
import { ALLOWED_ALTERNATIVES, ALWAYS_STRONG, BLOCKED_ALTERNATIVES, MIN_RESULTS_TO_JUDGE, QUERY_STOPWORDS, SKIP_MEMORY_DAYS, STRONG_RANK, STRONG_SHARE_TO_SKIP, STRONG_TLD, TENANT_HOSTS } from "@/config/serp-gate";
import { Budget, searchTurn } from "@/lib/ai/client";
import { sql } from "@/lib/db";
import { domainOf } from "@/lib/util";
import { domainCandidates, ensureTranco, ranksFor } from "./tranco";

export type Strength = { host: string; domain: string; strong: boolean; why: string };
export type GateResult = {
  /** pass: write it. skip: SERP too strong. unchecked: SERP or rank data unavailable, so the topic passes. */
  decision: "pass" | "skip" | "unchecked";
  strong: number;
  total: number;
  /** Unique domains, in ranking order. */
  domains: string[];
  strongDomains: string[];
  /** One line for people: "SERP too strong (7/10 strong: g2.com, capterra.com, ...)". */
  reason: string;
  /** Where the top 10 came from, and which rank list was used. */
  source: string;
};

const inList = (host: string, list: string[]) => list.some((d) => host === d || host.endsWith(`.${d}`));

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Domains that are the company the query is about: a known competitor named in the query, or a domain whose name is a word of the query. */
export function subjectDomains(query: string): Set<string> {
  const q = ` ${norm(query)} `;
  const out = new Set<string>();
  for (const c of [...BLOCKED_ALTERNATIVES, ...ALLOWED_ALTERNATIVES]) if (c.names.some((n) => q.includes(` ${norm(n)} `))) c.domains.forEach((d) => out.add(d));
  return out;
}

/** True if the domain's own name (first label) is a word of the query, or two neighbouring words joined: "zapier pricing" -> zapier.com. */
function nameInQuery(domain: string, query: string): boolean {
  const label = domain.split(".")[0];
  if (label.length < 4 || QUERY_STOPWORDS.has(label)) return false;
  const words = norm(query).split(" ").filter(Boolean);
  if (words.some((w) => w === label)) return true;
  return words.some((w, i) => i + 1 < words.length && w + words[i + 1] === label);
}

/** example.co.uk for a.example.co.uk when the rank list has nothing to say: the last two labels, or three under a country second level. */
function registrable(host: string): string {
  const labels = host.split(".");
  const three = labels.length >= 3 && /^(co|com|org|net|gov|ac|edu)$/.test(labels[labels.length - 2]) && labels[labels.length - 1].length === 2;
  return labels.slice(-(three ? 3 : 2)).join(".");
}

/** How strong one result's domain is. `ranks` maps Tranco domains to rank; null means the list is not available. */
export function strengthOf(url: string, query: string, ranks: Map<string, number> | null): Strength {
  const host = domainOf(url);
  const cands = domainCandidates(host);
  const ranked = cands.find((c) => ranks?.has(c));
  const domain = ranked ?? registrable(host);
  const base = (strong: boolean, why: string): Strength => ({ host, domain, strong, why });
  if (!host) return base(false, "no domain");
  if (inList(host, TENANT_HOSTS)) return base(false, "tenant site on a shared host");
  if (inList(host, ALWAYS_STRONG)) return base(true, "always-strong list");
  if (STRONG_TLD.test(host)) return base(true, "government or university");
  const subjects = subjectDomains(query);
  if (cands.some((c) => subjects.has(c)) || nameInQuery(domain, query)) return base(true, "the company the query is about");
  if (ranked && ranks!.get(ranked)! <= STRONG_RANK) return base(true, `Tranco rank ${ranks!.get(ranked)}`);
  return base(false, ranked ? `Tranco rank ${ranks!.get(ranked)}` : ranks ? "not in the Tranco top list" : "no rank data");
}

/** Pure scoring of a top 10. Tested with a mock SERP and a mock rank map. */
export function scoreSerp(query: string, urls: string[], ranks: Map<string, number> | null, source = "unknown"): GateResult {
  const results = urls.slice(0, 10).map((u) => strengthOf(u, query, ranks)).filter((s) => s.host);
  const total = results.length;
  const strong = results.filter((r) => r.strong).length;
  const uniq = (xs: string[]) => [...new Set(xs)];
  const domains = uniq(results.map((r) => r.domain));
  const strongDomains = uniq(results.filter((r) => r.strong).map((r) => r.domain));
  const shown = strongDomains.slice(0, 8).join(", ") + (strongDomains.length > 8 ? `, +${strongDomains.length - 8} more` : "");
  const listNote = ranks ? source : `${source}, rank list unavailable (fixed list only)`;
  if (total < MIN_RESULTS_TO_JUDGE)
    return { decision: "unchecked", strong, total, domains, strongDomains, source: listNote, reason: `SERP not checked: only ${total} results came back for "${query}"` };
  if (strong / total > STRONG_SHARE_TO_SKIP)
    return { decision: "skip", strong, total, domains, strongDomains, source: listNote, reason: `SERP too strong (${strong}/${total} strong: ${shown})` };
  return { decision: "pass", strong, total, domains, strongDomains, source: listNote, reason: `SERP is beatable (${strong}/${total} strong${strong ? `: ${shown}` : ""})` };
}

/** The current top results for a query, best first. Costs one search; never counts against the article's own search cap. */
export async function fetchSerp(query: string, budget: Budget): Promise<{ urls: string[]; source: string }> {
  if (process.env.SERPER_API_KEY) {
    // Optional: a real Google top 10 from serper.dev when the owner adds a key.
    const r = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: 10, gl: "us", hl: "en" }),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (r?.ok) {
      const j = (await r.json().catch(() => null)) as { organic?: { link?: string }[] } | null;
      const urls = (j?.organic ?? []).map((o) => o.link ?? "").filter(Boolean);
      if (urls.length) return { urls, source: "Google top 10 (serper.dev)" };
    }
  }
  const r = await searchTurn({
    budget,
    purpose: "serp_gate",
    maxSearches: 1,
    maxTokens: 300,
    system: "Run exactly one web search for the query you are given, then reply with the single word: done.",
    prompt: query,
  });
  return { urls: [...new Set(r.found.map((f) => f.url))], source: "Claude web search" };
}

export type GateDeps = {
  serp?: (query: string, budget: Budget) => Promise<{ urls: string[]; source: string }>;
  ranks?: (hosts: string[]) => Promise<Map<string, number> | null>;
};

const defaultRanks = async (hosts: string[]) => ((await ensureTranco()) ? ranksFor(hosts) : null);

/** Looks at the top 10 for a query and decides. Fails open: any error in the check means the topic passes (logged as unchecked). */
export async function checkSerp(query: string, budget: Budget, deps: GateDeps = {}): Promise<GateResult> {
  try {
    const serp = await (deps.serp ?? fetchSerp)(query, budget);
    let ranks: Map<string, number> | null = null;
    try { ranks = await (deps.ranks ?? defaultRanks)(serp.urls.map(domainOf).filter(Boolean)); } catch (e) { console.warn(`rank lookup failed: ${(e as Error).message}`); }
    return scoreSerp(query, serp.urls, ranks, serp.source);
  } catch (e) {
    if ((e as { name?: string }).name === "CapReached") throw e;
    return { decision: "unchecked", strong: 0, total: 0, domains: [], strongDomains: [], source: "error", reason: `SERP not checked: ${(e as Error).message}` };
  }
}

export type GateLogEntry = {
  siteId: string;
  articleId?: string | null;
  topic?: string | null;
  query: string;
  decision: "pass" | "skip" | "unchecked" | "blocked" | "exhausted" | "override";
  reason: string;
  gate?: GateResult;
};

/** One row in serp_gate_log. Never throws: logging must not stop an article. */
export async function logGate(e: GateLogEntry): Promise<void> {
  try {
    await sql()`insert into serp_gate_log (site_id, article_id, topic, target_query, decision, strong_count, total, strong_domains, domains, reason, source)
      values (${e.siteId}, ${e.articleId ?? null}, ${e.topic ?? null}, ${e.query}, ${e.decision}, ${e.gate?.strong ?? null}, ${e.gate?.total ?? null},
        ${sql().json((e.gate?.strongDomains ?? []) as never)}, ${sql().json((e.gate?.domains ?? []) as never)}, ${e.reason}, ${e.gate?.source ?? null})`;
  } catch (err) {
    console.warn(`serp gate log failed: ${(err as Error).message}`);
  }
}

/** Queries this site skipped or blocked recently, so the next pick does not return to them. */
export async function recentlySkipped(siteId: string): Promise<string[]> {
  try {
    const rows = await sql()`select distinct target_query q, topic from serp_gate_log where site_id = ${siteId} and decision in ('skip','blocked')
      and created_at > now() - make_interval(days => ${SKIP_MEMORY_DAYS})`;
    return rows.flatMap((r) => [r.q, r.topic]).filter(Boolean) as string[];
  } catch {
    return [];
  }
}

/** True while the hourly scheduler should leave this site alone because a whole round of candidates was skipped. */
export async function inCooldown(siteId: string, hours: number): Promise<boolean> {
  try {
    const [r] = await sql()`select 1 from serp_gate_log where site_id = ${siteId} and decision = 'exhausted' and created_at > now() - make_interval(hours => ${hours})`;
    return !!r;
  } catch {
    return false;
  }
}

