// Google Search Console: sign-in with Google (read-only scope) and the daily data pull.
// Scope is webmasters.readonly only, the narrowest one that reads search performance.
import { appUrl } from "@/config/brand";
import { sql } from "@/lib/db";
import { domainOf } from "@/lib/util";

export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const API = "https://searchconsole.googleapis.com/webmasters/v3";

export const gscConfigured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const redirectUri = () => appUrl("/api/gsc/callback");

export function authUrl(state: string): string {
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: GSC_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function tokenRequest(params: Record<string, string>) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, ...params }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error === "invalid_grant" ? `invalid_grant: ${j.error_description ?? "the refresh token was expired or revoked"}` : (j.error_description ?? j.error ?? `Google answered ${r.status}`));
  return j as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
}

export const exchangeCode = (code: string) => tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });
export const refreshAccess = async (refresh: string) => (await tokenRequest({ refresh_token: refresh, grant_type: "refresh_token" })).access_token;

async function gsc<T>(token: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text).error?.message ?? msg; } catch { /* raw */ }
    throw new Error(`Search Console ${r.status}: ${msg}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export type Property = { siteUrl: string; permissionLevel: string };
export async function listProperties(token: string): Promise<Property[]> {
  const r = await gsc<{ siteEntry?: Property[] }>(token, "/sites");
  return (r.siteEntry ?? []).filter((s) => s.permissionLevel !== "siteUnverifiedUser");
}

/** The property for a site: URL-prefix match first, then the domain property. */
export function matchProperty(props: Property[], siteUrl: string): Property | null {
  const host = domainOf(siteUrl);
  return (
    props.find((p) => !p.siteUrl.startsWith("sc-domain:") && domainOf(p.siteUrl) === host) ??
    props.find((p) => p.siteUrl === `sc-domain:${host}`) ??
    props.find((p) => p.siteUrl.startsWith("sc-domain:") && host.endsWith(`.${p.siteUrl.slice(10)}`)) ??
    null
  );
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Pulls daily rows (date, query, page) for the last `days` days into gsc_rows. Returns rows stored. */
export async function syncSite(siteId: string, days = 5): Promise<number> {
  try {
    return await syncSiteRows(siteId, days);
  } catch (e) {
    await recordGscError(siteId, e);
    throw e;
  }
}

/** True when Google no longer accepts the saved connection, so the site owner has to connect Search Console again. */
export const needsReconnect = (message: string) => /invalid_grant|expired or revoked|invalid_client/i.test(message);

/** Remembers why the last pull failed so it shows in the admin panel and the logs instead of vanishing. */
export async function recordGscError(siteId: string, e: unknown): Promise<void> {
  const msg = e instanceof Error ? e.message : String(e);
  const text = (needsReconnect(msg) ? `Reconnect needed. ${msg}` : msg).slice(0, 500);
  console.error(`gsc: site ${siteId} failed: ${text}`);
  await sql()`update sites set gsc_error = ${text}, gsc_error_at = now() where id = ${siteId}`.catch((err) => console.error("gsc: could not record the error", err));
}

async function syncSiteRows(siteId: string, days: number): Promise<number> {
  const db = sql();
  const [row] = await db`select s.id, s.owner_id, s.gsc_property, k.gsc_refresh_token from sites s join site_secrets k on k.site_id = s.id where s.id = ${siteId}`;
  if (!row?.gsc_property || !row.gsc_refresh_token) return 0;
  const token = await refreshAccess(row.gsc_refresh_token);
  const end = new Date(Date.now() - 24 * 3600e3);
  const start = new Date(end.getTime() - (days - 1) * 24 * 3600e3);
  let stored = 0;
  for (let startRow = 0; startRow < 100_000; startRow += 25_000) {
    const r = await gsc<{ rows?: { keys: string[]; clicks: number; impressions: number; position: number }[] }>(
      token,
      `/sites/${encodeURIComponent(row.gsc_property)}/searchAnalytics/query`,
      { startDate: day(start), endDate: day(end), dimensions: ["date", "query", "page"], rowLimit: 25_000, startRow, type: "web", dataState: "all" },
    );
    const rows = r.rows ?? [];
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000).map((x) => ({
        site_id: siteId, owner_id: row.owner_id, date: x.keys[0], query: x.keys[1].slice(0, 500), page: x.keys[2].slice(0, 1000),
        clicks: Math.round(x.clicks), impressions: Math.round(x.impressions), position: x.position,
      }));
      await db`insert into gsc_rows ${db(chunk)} on conflict (site_id, date, query, page) do update set
        clicks = excluded.clicks, impressions = excluded.impressions, position = excluded.position`;
      stored += chunk.length;
    }
    if (rows.length < 25_000) break;
  }
  await db`update sites set gsc_last_sync = now(), gsc_error = null, gsc_error_at = null where id = ${siteId}`;
  return stored;
}

/**
 * Search Console totals per day for one site, from `startDate` to `endDate` (YYYY-MM-DD). Uses the date dimension alone, so
 * anonymized queries are included and the totals match what Search Console reports. Days without impressions are not returned.
 */
export async function siteDailyTotals(siteId: string, startDate: string, endDate: string): Promise<{ date: string; clicks: number; impressions: number; position: number }[]> {
  const [row] = await sql()`select s.gsc_property, k.gsc_refresh_token from sites s join site_secrets k on k.site_id = s.id where s.id = ${siteId}`;
  if (!row?.gsc_property || !row.gsc_refresh_token) throw new Error("Search Console is not connected for this site.");
  const token = await refreshAccess(row.gsc_refresh_token);
  const r = await gsc<{ rows?: { keys: string[]; clicks: number; impressions: number; position: number }[] }>(
    token,
    `/sites/${encodeURIComponent(row.gsc_property)}/searchAnalytics/query`,
    { startDate, endDate, dimensions: ["date"], rowLimit: 25_000, type: "web" },
  );
  return (r.rows ?? []).map((x) => ({ date: x.keys[0], clicks: Math.round(x.clicks), impressions: Math.round(x.impressions), position: x.position })).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Pulls Search Console totals per day from `startDate` through today and stores one row per day in gsc_daily_totals.
 * On success the fetch time is saved (the pages hide the numbers when it is more than 3 days old); on failure the error is
 * saved and thrown, and the rows already stored are left alone. Returns the latest date Google returned, or null.
 */
export async function syncDailyTotals(siteId: string, startDate: string, endDate: string, source: "paperboy_oauth" | "hub_gsc" = "paperboy_oauth"): Promise<string | null> {
  try {
    const rows = await siteDailyTotals(siteId, startDate, endDate);
    const db = sql();
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map((r) => ({ site_id: siteId, date: r.date, clicks: r.clicks, impressions: r.impressions, position: r.position, fetched_at: new Date().toISOString(), source }));
      await db`insert into gsc_daily_totals ${db(chunk)} on conflict (site_id, date) do update set
        clicks = excluded.clicks, impressions = excluded.impressions, position = excluded.position, fetched_at = excluded.fetched_at, source = excluded.source`;
    }
    await db`update sites set gsc_totals_fetched_at = now(), gsc_error = null, gsc_error_at = null where id = ${siteId}`;
    return rows.length ? rows[rows.length - 1].date : null;
  } catch (e) {
    await recordGscError(siteId, e);
    throw e;
  }
}

/** The stored per-day totals for one site plus when they were last fetched successfully. */
export async function storedDailyTotals(siteId: string): Promise<{ rows: { date: string; clicks: number; impressions: number; position: number }[]; fetchedAt: string | null; error: string | null }> {
  const db = sql();
  const rows = await db`select to_char(date, 'YYYY-MM-DD') date, clicks, impressions, position from gsc_daily_totals where site_id = ${siteId} order by date`;
  const [s] = await db`select gsc_totals_fetched_at, gsc_error from sites where id = ${siteId}`;
  return {
    rows: rows.map((r) => ({ date: r.date as string, clicks: r.clicks as number, impressions: r.impressions as number, position: Number(r.position) })),
    fetchedAt: s?.gsc_totals_fetched_at ? new Date(s.gsc_totals_fetched_at).toISOString() : null,
    error: (s?.gsc_error as string | null) ?? null,
  };
}
