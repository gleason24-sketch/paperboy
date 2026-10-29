// Page snapshots (pure, unit-tested): what changed in a page's title tag or meta description since yesterday.
export type Snapshot = { title: string | null; meta_description: string | null; h1: string | null };
export type TitleMetaChange = { old: { title: string | null; meta: string | null }; new: { title: string | null; meta: string | null } };

export const SNAPSHOT_PAGES = 25;

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** Same page whichever way Google or the site writes it (mirrors seo_page_key() in the database). */
export const normUrl = (u: string) => u.split("#")[0].split("?")[0].toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");

/**
 * What changed since the last snapshot. No previous snapshot (first sight) is never a change. A field that came back
 * empty is treated as a failed read, not as a removal, so a flaky fetch never logs a fake change.
 */
export function diffTitleMeta(prev: Snapshot | null, next: Snapshot): TitleMetaChange | null {
  if (!prev) return null;
  const titleChanged = !!norm(next.title) && norm(prev.title) !== norm(next.title);
  const metaChanged = !!norm(next.meta_description) && norm(prev.meta_description) !== norm(next.meta_description);
  if (!titleChanged && !metaChanged) return null;
  return { old: { title: prev.title, meta: prev.meta_description }, new: { title: next.title, meta: next.meta_description } };
}

/** True when a change for this page was already logged inside the window (one change is logged per page per week). */
export function recentlyLogged(existing: { page_url: string; changed_at: string }[], page: string, now = Date.now(), days = 7): boolean {
  const key = normUrl(page);
  return existing.some((a) => normUrl(a.page_url) === key && now - Date.parse(a.changed_at) < days * 864e5);
}

/** The pages worth watching: top by current-window impressions, on the customer's own host, deduped by normalized URL. */
export function pagesToWatch(rows: { win: string; page: string; impressions: number }[], siteUrl: string | null, limit = SNAPSHOT_PAGES): string[] {
  const host = (u: string) => u.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase().replace(/^www\./, "");
  const own = siteUrl ? host(siteUrl) : null;
  const impr = new Map<string, { url: string; n: number; best: number }>();
  for (const r of rows) {
    if (r.win !== "cur" || !/^https?:\/\//i.test(r.page)) continue;
    if (own && host(r.page) !== own && !host(r.page).endsWith(`.${own}`)) continue;
    const k = normUrl(r.page);
    const e = impr.get(k) ?? { url: r.page, n: 0, best: -1 };
    e.n += r.impressions;
    if (r.impressions > e.best) { e.best = r.impressions; e.url = r.page; }
    impr.set(k, e);
  }
  return [...impr.values()].sort((a, b) => b.n - a.n).slice(0, limit).map((e) => e.url);
}
