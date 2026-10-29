// Domain strength without a paid API: the Tranco list (https://tranco-list.eu), downloaded at most once a week and kept in
// the tranco_ranks table (top 100,000 only). If the list cannot be downloaded the gate falls back to its fixed list of
// always-strong domains and says so in the log.
import { TRANCO_KEEP, TRANCO_MAX_AGE_DAYS } from "@/config/serp-gate";
import { sql } from "@/lib/db";

const KEY = "tranco_list";
const LOCK = "tranco_lock";

type Meta = { id: string; fetchedAt: string; rows: number };

async function setting(key: string): Promise<{ value: string; updated_at: string } | null> {
  const [r] = await sql()`select value, updated_at from app_settings where key = ${key}`;
  return (r as { value: string; updated_at: string }) ?? null;
}
const put = (key: string, value: string) =>
  sql()`insert into app_settings (key, value) values (${key}, ${value}) on conflict (key) do update set value = excluded.value, updated_at = now()`;

/** The parent domains of a host, most specific first, at least two labels: a.b.example.co.uk -> a.b.example.co.uk, b.example.co.uk, example.co.uk, co.uk. */
export function domainCandidates(host: string): string[] {
  const labels = host.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
}

/** Parses Tranco's "rank,domain" CSV. Bad lines are dropped. */
export function parseTranco(csv: string, keep = TRANCO_KEEP): { domain: string; rank: number }[] {
  const out: { domain: string; rank: number }[] = [];
  for (const line of csv.split("\n")) {
    const i = line.indexOf(",");
    if (i < 1) continue;
    const rank = Number(line.slice(0, i));
    const domain = line.slice(i + 1).trim().toLowerCase();
    if (!Number.isInteger(rank) || rank < 1 || rank > keep || !domain.includes(".")) continue;
    out.push({ domain, rank });
  }
  return out;
}

/** Downloads the latest list and swaps it in. Returns a short note for the log. */
async function refresh(): Promise<string> {
  const latest = (await (await fetch("https://tranco-list.eu/api/lists/date/latest", { signal: AbortSignal.timeout(20_000) })).json()) as { list_id?: string };
  if (!latest.list_id) throw new Error("Tranco did not name a list");
  const res = await fetch(`https://tranco-list.eu/download/${latest.list_id}/${TRANCO_KEEP}`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Tranco download answered ${res.status}`);
  const rows = parseTranco(await res.text());
  if (rows.length < TRANCO_KEEP * 0.9) throw new Error(`Tranco list looks truncated (${rows.length} rows)`);
  const db = sql();
  for (let i = 0; i < rows.length; i += 5000) {
    const chunk = rows.slice(i, i + 5000).map((r) => ({ domain: r.domain, rank: r.rank, list_id: latest.list_id! }));
    await db`insert into tranco_ranks ${db(chunk)} on conflict (domain) do update set rank = excluded.rank, list_id = excluded.list_id`;
  }
  await db`delete from tranco_ranks where list_id <> ${latest.list_id}`;
  await put(KEY, JSON.stringify({ id: latest.list_id, fetchedAt: new Date().toISOString(), rows: rows.length } satisfies Meta));
  return `Tranco list ${latest.list_id} stored (${rows.length} domains)`;
}

/**
 * Makes sure a reasonably fresh list is stored. Safe to call on every gate check: it does nothing while the stored list is
 * under a week old, and a ten minute lock keeps two article runs from downloading at once. Never throws.
 * Returns the list id in use, or null when there is none.
 */
export async function ensureTranco(): Promise<string | null> {
  try {
    const cur = await setting(KEY);
    const meta = cur ? (JSON.parse(cur.value) as Meta) : null;
    const age = meta ? (Date.now() - Date.parse(meta.fetchedAt)) / 86_400_000 : Infinity;
    if (meta && age < TRANCO_MAX_AGE_DAYS) return meta.id;
    const lock = await setting(LOCK);
    if (!lock || Date.now() - Date.parse(lock.updated_at) > 10 * 60_000) {
      await put(LOCK, new Date().toISOString());
      try { console.log(await refresh()); } catch (e) { console.warn(`tranco refresh failed: ${(e as Error).message}`); }
    }
    const after = await setting(KEY);
    return after ? (JSON.parse(after.value) as Meta).id : meta?.id ?? null;
  } catch (e) {
    console.warn(`tranco check failed: ${(e as Error).message}`);
    return null;
  }
}

/** Ranks for a set of hosts: for every host, the best (lowest) rank among it and its parent domains. */
export async function ranksFor(hosts: string[]): Promise<Map<string, number>> {
  const cands = [...new Set(hosts.flatMap(domainCandidates))];
  const out = new Map<string, number>();
  if (!cands.length) return out;
  const db = sql();
  const rows = (await db`select domain, rank from tranco_ranks where domain in ${db(cands)}`) as unknown as { domain: string; rank: number }[];
  for (const r of rows) out.set(r.domain, r.rank);
  return out;
}
