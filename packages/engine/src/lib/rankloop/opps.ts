// Rank loop opportunities (pure, unit-tested): turns 56 days of a customer site's Search Console data into the short list of fixes
// Paperboy acts on (title/meta rewrites, new articles, refreshes) or shows in the dashboard. Rows come from loadOppRows() in run.ts.

export const HIDDEN_QUERY = "(hidden by Google)";

export type OppRow = {
  win: "cur" | "prior" | "cur_total" | "prior_total";
  page: string;
  query: string;
  clicks: number;
  impressions: number;
  position: number | null;
};

export type DailyRow = { date: string; query: string; page: string; clicks: number; impressions: number; position: number | null };

export const CAPS = { ctr_fix: 10, push_to_1: 10, striking_distance: 10, needs_own_page: 8, cluster: 5, slipping: 5 } as const;

export const RULE = "Work the top ctr_fix and needs_own_page items first, then push_to_1. Never change a URL. A changed title is measured automatically 28 days later.";

/** Typical organic click-through rate by position (rounded). */
export function expectedCtr(position: number): number {
  const p = Math.max(1, Math.round(position));
  const curve = [0.28, 0.15, 0.11, 0.08, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02];
  return p <= 10 ? curve[p - 1] : 0.015;
}

const STOP = new Set(("a an the and or of for to in on at by with from is are was were be do does did how what why when where which who whom can should " +
  "will would could my your our i me we you it its this that these those vs versus best top near me us as about into than then there their " +
  "get got via per not no yes if any all").split(/\s+/));

/** Meaningful lowercase words of a query or URL path (stopwords dropped, plural -s folded). */
export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || STOP.has(raw)) continue;
    const t = raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** "https://www.example.com/guides/x/?a=1#b" -> "/guides/x". The home page is "/". */
export function pathOf(url: string): string {
  const noOrigin = String(url ?? "").replace(/^https?:\/\/[^/]+/i, "");
  const p = noOrigin.split("#")[0].split("?")[0].replace(/\/+$/, "");
  return p ? (p.startsWith("/") ? p : `/${p}`) : "/";
}

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const ctrOf = (clicks: number, imps: number) => (imps > 0 ? round(clicks / imps, 4) : 0);

type Agg = { clicks: number; impressions: number; posW: number };
const add = (a: Agg, r: { clicks: number; impressions: number; position: number | null }) => {
  a.clicks += r.clicks; a.impressions += r.impressions; a.posW += (r.position ?? 0) * r.impressions;
};
const avgPos = (a: Agg) => (a.impressions > 0 && a.posW > 0 ? round(a.posW / a.impressions) : null);

/**
 * Pure JS twin of the SQL function, for tests and any caller holding raw daily rows. The current window is the
 * `days` days ending at the newest date present; the prior window is the `days` before it.
 */
export function aggregateDaily(daily: DailyRow[], days = 28): OppRow[] {
  if (!daily.length) return [];
  const newest = daily.reduce((m, r) => (r.date > m ? r.date : m), daily[0].date);
  const end = Date.parse(newest);
  const dayIndex = (d: string) => Math.round((end - Date.parse(d)) / 864e5); // 0 = newest day
  const cur = new Map<string, Agg & { page: string; query: string }>();
  const prior = new Map<string, Agg & { page: string }>();
  const tot = { cur: { clicks: 0, impressions: 0, posW: 0 }, prior: { clicks: 0, impressions: 0, posW: 0 } };
  for (const r of daily) {
    const i = dayIndex(r.date);
    if (i < 0 || i >= 2 * days) continue;
    const w = i < days ? "cur" : "prior";
    add(tot[w], { ...r, position: 0 });
    if (!r.page || r.query === HIDDEN_QUERY) continue;
    const pk = pathOf(r.page).toLowerCase();
    if (w === "cur") {
      const k = `${pk}\u0000${r.query.toLowerCase()}`;
      const a = cur.get(k) ?? { clicks: 0, impressions: 0, posW: 0, page: r.page, query: r.query.toLowerCase() };
      add(a, r); cur.set(k, a);
    } else {
      const a = prior.get(pk) ?? { clicks: 0, impressions: 0, posW: 0, page: r.page };
      add(a, r); prior.set(pk, a);
    }
  }
  const out: OppRow[] = [];
  for (const a of cur.values()) out.push({ win: "cur", page: a.page, query: a.query, clicks: a.clicks, impressions: a.impressions, position: avgPos(a) });
  for (const a of prior.values()) out.push({ win: "prior", page: a.page, query: "", clicks: a.clicks, impressions: a.impressions, position: avgPos(a) });
  out.push({ win: "cur_total", page: "", query: "", clicks: tot.cur.clicks, impressions: tot.cur.impressions, position: null });
  out.push({ win: "prior_total", page: "", query: "", clicks: tot.prior.clicks, impressions: tot.prior.impressions, position: null });
  return out;
}

/** Impression thresholds, halved (never below 3) for a site under 300 impressions in 28 days. */
export function thresholds(totalImpressions: number) {
  const f = (n: number) => (totalImpressions < 300 ? Math.max(3, Math.ceil(n / 2)) : n);
  return { ctrFix: f(30), pushToOne: f(10), striking: f(10), ownPage: f(10), slipping: f(20), small: totalImpressions < 300 };
}

type QRow = { page: string; path: string; query: string; clicks: number; impressions: number; position: number };
const byImpr = <T extends { impressions: number }>(a: T, b: T) => b.impressions - a.impressions;
const topQueries = (rows: QRow[], n: number) =>
  rows.slice().sort(byImpr).slice(0, n).map((r) => ({ query: r.query, impressions: r.impressions, clicks: r.clicks, position: round(r.position, 1) }));

/** How much of the query's meaningful words the page path contains (0 to 1). */
export function pathMatch(queryTokens: string[], path: string): number {
  if (!queryTokens.length) return 1;
  const pt = new Set(tokens(path.replace(/[/_.-]+/g, " ")));
  return queryTokens.filter((t) => pt.has(t)).length / queryTokens.length;
}

export function computeOpportunities(rows: OppRow[]) {
  const curTotal = rows.find((r) => r.win === "cur_total");
  const cur: QRow[] = rows.filter((r) => r.win === "cur" && r.page && r.query && r.impressions > 0 && r.position != null && r.query !== HIDDEN_QUERY)
    .map((r) => ({ page: r.page, path: pathOf(r.page), query: r.query, clicks: r.clicks, impressions: r.impressions, position: Number(r.position) }));
  const curSum = cur.reduce((s, r) => s + r.impressions, 0);
  const totalImpr = curTotal?.impressions ?? curSum;
  const T = thresholds(totalImpr);

  // ----- per page rollups -----
  const pages = new Map<string, { path: string; rows: QRow[]; agg: Agg }>();
  for (const r of cur) {
    const p = pages.get(r.path) ?? { path: r.path, rows: [], agg: { clicks: 0, impressions: 0, posW: 0 } };
    p.rows.push(r); add(p.agg, r); pages.set(r.path, p);
  }
  const base = (p: { path: string; agg: Agg }) => ({ page: p.path, impressions: p.agg.impressions, clicks: p.agg.clicks, ctr: ctrOf(p.agg.clicks, p.agg.impressions), position: avgPos(p.agg) });

  // ----- ctr_fix -----
  const ctr_fix = [...pages.values()].flatMap((p) => {
    const pos = avgPos(p.agg);
    if (p.agg.impressions < T.ctrFix || pos == null || pos > 12) return [];
    const exp = expectedCtr(pos), ctr = p.agg.clicks / p.agg.impressions;
    if (ctr >= exp * 0.5) return [];
    return [{
      type: "ctr_fix" as const, ...base(p), expected_ctr: exp, queries: topQueries(p.rows, 5),
      why: `Ranks about #${round(pos, 1)} but only ${round(ctr * 100, 1)}% click (expected ~${round(exp * 100, 1)}%).`,
      do: "Rewrite title + meta description to match the top query; keep URL.",
    }];
  }).sort(byImpr).slice(0, CAPS.ctr_fix);

  // ----- push_to_1 / striking_distance -----
  const pq = (r: QRow) => ({ page: r.path, query: r.query, impressions: r.impressions, clicks: r.clicks, ctr: ctrOf(r.clicks, r.impressions), position: round(r.position, 1) });
  const push_to_1 = cur.filter((r) => r.position >= 1.5 && r.position <= 10 && r.impressions >= T.pushToOne).sort(byImpr).slice(0, CAPS.push_to_1).map((r) => ({
    type: "push_to_1" as const, ...pq(r),
    why: `Already #${round(r.position, 1)} for "${r.query}": the top spot takes the most clicks.`,
    do: "Strengthen: answer in the first 2 sentences, exact query in H1 and title, add an FAQ, link in from the strongest pages, show a freshness date.",
  }));
  const striking_distance = cur.filter((r) => r.position >= 10.5 && r.position <= 30 && r.impressions >= T.striking).sort(byImpr).slice(0, CAPS.striking_distance).map((r) => ({
    type: "striking_distance" as const, ...pq(r),
    why: `Page ${Math.ceil(r.position / 10)} of Google (#${round(r.position, 1)}) for "${r.query}": close enough to move with a better page.`,
    do: "Refresh and expand the section that answers this query, and add internal links to it.",
  }));

  // ----- needs_own_page -----
  const needs_own_page = (() => {
    const allPaths = [...pages.keys()];
    const best = new Map<string, QRow>(); // the page that ranks for the query with most impressions
    for (const r of cur) if (r.impressions >= T.ownPage && (!best.has(r.query) || r.impressions > best.get(r.query)!.impressions)) best.set(r.query, r);
    const items = [];
    for (const r of best.values()) {
      if (r.path === "/") continue; // brand and home queries belong on the home page
      const qt = tokens(r.query);
      if (!qt.length) continue;
      if (pathMatch(qt, r.path) >= 0.5) continue;
      if (allPaths.some((p) => p !== r.path && pathMatch(qt, p) >= 0.5)) continue; // the site already has a better-matching page
      items.push({
        type: "needs_own_page" as const, query: r.query, ranking_page: r.path, impressions: r.impressions, clicks: r.clicks, ctr: ctrOf(r.clicks, r.impressions), position: round(r.position, 1),
        why: `"${r.query}" ranks from ${r.path}, a page that is not about it.`,
        do: "Create a dedicated page targeting this query, and link to it from the ranking page.",
      });
    }
    return items.sort(byImpr).slice(0, CAPS.needs_own_page);
  })();

  // ----- cluster -----
  const cluster = (() => {
    const pool = cur.filter((r) => r.position >= 20 && r.position <= 70);
    const byTerm = new Map<string, Set<string>>();
    const qrow = new Map<string, QRow[]>();
    for (const r of pool) {
      qrow.set(r.query, [...(qrow.get(r.query) ?? []), r]);
      for (const t of tokens(r.query)) byTerm.set(t, (byTerm.get(t) ?? new Set()).add(r.query));
    }
    const imprOf = (qs: Iterable<string>) => { let n = 0; for (const q of qs) for (const r of qrow.get(q)!) n += r.impressions; return n; };
    const taken = new Set<string>();
    const out = [];
    for (;;) {
      let pick: { term: string; qs: string[]; impr: number } | null = null;
      for (const [term, set] of byTerm) {
        const qs = [...set].filter((q) => !taken.has(q));
        if (qs.length < 3) continue;
        const impr = imprOf(qs);
        if (!pick || qs.length > pick.qs.length || (qs.length === pick.qs.length && impr > pick.impr)) pick = { term, qs, impr };
      }
      if (!pick) break;
      pick.qs.forEach((q) => taken.add(q));
      const rowsIn = pick.qs.flatMap((q) => qrow.get(q)!);
      const agg: Agg = { clicks: 0, impressions: 0, posW: 0 };
      rowsIn.forEach((r) => add(agg, r));
      const perPage = new Map<string, number>();
      rowsIn.forEach((r) => perPage.set(r.path, (perPage.get(r.path) ?? 0) + r.impressions));
      out.push({
        type: "cluster" as const, term: pick.term, query_count: pick.qs.length, impressions: agg.impressions, clicks: agg.clicks, position: avgPos(agg),
        best_pages: [...perPage].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => p),
        queries: pick.qs.sort((a, b) => imprOf([b]) - imprOf([a])).slice(0, 5),
        why: `${pick.qs.length} queries about "${pick.term}" sit at positions 20 to 70: Google sees you on the topic but not as an authority.`,
        do: "Work the cluster: one hub page on the term plus linked supporting pages for the queries.",
      });
    }
    return out.sort(byImpr).slice(0, CAPS.cluster);
  })();

  // ----- slipping -----
  const slipping = (() => {
    const out = [];
    for (const pr of rows.filter((r) => r.win === "prior" && r.page)) {
      if (pr.impressions < T.slipping) continue;
      const path = pathOf(pr.page);
      const now = pages.get(path);
      const nowC = now?.agg.clicks ?? 0, nowI = now?.agg.impressions ?? 0, nowPos = now ? avgPos(now.agg) : null;
      const reasons: string[] = [];
      const drop = (a: number, b: number) => a > 0 && (a - b) / a >= 0.3;
      if (drop(pr.clicks, nowC)) reasons.push(`clicks ${pr.clicks} to ${nowC}`);
      if (drop(pr.impressions, nowI)) reasons.push(`impressions ${pr.impressions} to ${nowI}`);
      if (nowPos != null && pr.position != null && nowPos - pr.position >= 3) reasons.push(`position ${round(pr.position, 1)} to ${round(nowPos, 1)}`);
      if (!reasons.length) continue;
      out.push({
        type: "slipping" as const, page: path, impressions: nowI, clicks: nowC, ctr: ctrOf(nowC, nowI), position: nowPos,
        prior_impressions: pr.impressions, prior_clicks: pr.clicks, prior_position: pr.position != null ? round(pr.position, 1) : null,
        why: `Down vs the 28 days before: ${reasons.join(", ")}.`,
        do: "Refresh: update facts and dates, tighten the answer, re-check the title, add internal links.",
      });
    }
    return out.sort((a, b) => b.prior_impressions - a.prior_impressions).slice(0, CAPS.slipping);
  })();

  // ----- summary -----
  const all: Agg = { clicks: 0, impressions: 0, posW: 0 };
  cur.forEach((r) => add(all, r));
  const perQuery = new Map<string, QRow[]>();
  cur.forEach((r) => perQuery.set(r.query, [...(perQuery.get(r.query) ?? []), r]));
  const top_queries = [...perQuery].map(([query, rs]) => {
    const a: Agg = { clicks: 0, impressions: 0, posW: 0 };
    rs.forEach((r) => add(a, r));
    return { query, impressions: a.impressions, clicks: a.clicks, position: avgPos(a) };
  }).sort(byImpr).slice(0, 5);

  return {
    status: "ok" as const,
    window: "last 28 days vs the 28 before",
    summary: {
      clicks_28d: curTotal?.clicks ?? all.clicks, impressions_28d: totalImpr, avg_position: avgPos(all), top_queries,
      ...(T.small ? { small_site: "Under 300 impressions in 28 days, so the impression thresholds are halved." } : {}),
    },
    rule: RULE,
    ctr_fix, needs_own_page, push_to_1, striking_distance, cluster, slipping,
  };
}

export type SeoOpportunities = ReturnType<typeof computeOpportunities>;
