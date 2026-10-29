// SPDX-License-Identifier: AGPL-3.0-only
// The self-host HTTP server: a dependency-free node:http server that exposes the REST API the CLI and MCP server talk to,
// the device approval page, and a health check. Run it with `tsx src/server/server.ts` (PORT, default 3000).
//
// The database connection is the paperboy_server role, which bypasses row-level security, so EVERY query below filters by the
// owner_id of the API key. The database accessor is injectable (createServer({ sql })) so the routing, auth and error shapes
// can be tested without a Postgres.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { sql as realSql } from "@/lib/db";
import type { QualityInput, QualitySource, Verdict } from "@/lib/quality/types";
import { extractLinks, hostOfUrl, htmlToMarkdown, simplifyChecks, titleOfMarkdown, verdictToChecks } from "./factcheck";
import { generateApiKey, generateDeviceCode, generateUserCode, keyPrefix, normalizeUserCode, parseBearer, requestId, safeEqual, sha256Hex } from "./keys";

export type Row = Record<string, any>;
/** The tagged-template query function (postgres.js in production, a fake in tests). */
export type Sql = (strings: TemplateStringsArray, ...values: any[]) => PromiseLike<Row[]>;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export type TopicPickLike = { topic: string; target_query: string; angle?: string; intent?: string; reason?: string };
export type PageLike = { finalUrl: string; title: string; text: string; html: string };

/** Everything the server needs from the engine. The defaults import lazily, so tests never load the AI client. */
export type Engine = {
  kickArticle(articleId: string): Promise<void>;
  suggestTopics(site: Row, n: number): Promise<TopicPickLike[]>;
  topicSignals(siteId: string, query: string): Promise<{ impressions: number | null; position: number | null }>;
  scanSite(url: string): Promise<Row | null>;
  finalizePublish(articleId: string): Promise<{ ok: boolean; message: string }>;
  fetchPage(url: string, timeoutMs?: number): Promise<PageLike>;
  /** `local` forces the open local verifier (used by POST /verify so a hosted setting can never loop back to itself). */
  verify(input: QualityInput, ctx: { ownerId: string; local?: boolean }): Promise<Verdict>;
};

export type ServerOptions = {
  sql?: () => Sql;
  engine?: Partial<Engine>;
  env?: Record<string, string | undefined>;
  /** Log sink. Defaults to console.log. */
  log?: (line: string) => void;
  now?: () => number;
};

// ---------------------------------------------------------------------------------------------------------------------
// small utilities

export const VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
})();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_JSON_BYTES = 3_000_000;
const MAX_FORM_BYTES = 16_000;

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const clampInt = (v: unknown, min: number, max: number, dflt: number) => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
};

/** Sliding-window counter, in memory. Used for failed device approvals, bad API keys and unauthenticated code creation. */
export class Limiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number, private now: () => number = Date.now) {}
  private recent(key: string) {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }
  blocked(key: string): boolean {
    return this.recent(key).length >= this.max;
  }
  hit(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.hits.set(key, list);
    if (this.hits.size > 5000) for (const k of this.hits.keys()) this.recent(k);
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// default engine (lazy imports)

function defaultEngine(): Engine {
  return {
    async kickArticle(id) {
      const { kickArticle } = await import("@/lib/jobs");
      await kickArticle(id);
    },
    async suggestTopics(site, n) {
      const { suggestTopics } = await import("@/lib/engine/topics");
      const { Budget } = await import("@/lib/ai/client");
      const budget = new Budget({ ownerId: site.owner_id, siteId: site.id, articleId: null }, { usd: 0.25, tokens: 60_000, searches: 0 });
      return (await suggestTopics(site as never, budget, n)) as TopicPickLike[];
    },
    async topicSignals(siteId, query) {
      const { gscSignals } = await import("@/lib/engine/topics");
      const s = await gscSignals(siteId);
      const q = query.trim().toLowerCase();
      const hit = [...s.pageTwo, ...s.questions, ...s.nearClicks].find((x) => x.query.trim().toLowerCase() === q);
      return { impressions: hit ? hit.impressions : null, position: hit ? hit.position : null };
    },
    async scanSite(url) {
      const { scanSite } = await import("@/lib/engine/scan");
      return (await scanSite(url)) as unknown as Row;
    },
    async finalizePublish(id) {
      const { finalizePublish } = await import("@/lib/engine/pipeline");
      return finalizePublish(id);
    },
    async fetchPage(url, timeoutMs) {
      const { fetchPage } = await import("@/lib/fetchpage");
      const p = await fetchPage(url, timeoutMs);
      return { finalUrl: p.finalUrl, title: p.title, text: p.text, html: p.html };
    },
    async verify(input, ctx) {
      const { Budget } = await import("@/lib/ai/client");
      const quality = await import("@/lib/quality");
      const budget = new Budget({ ownerId: ctx.ownerId, siteId: null, articleId: null }, { usd: 0.5, tokens: 300_000, searches: 0 });
      if (ctx.local) {
        const { defaultJudge } = await import("@/lib/quality/judges");
        return new quality.LocalVerifier(defaultJudge(budget)).verify(input);
      }
      return quality.getVerifier(budget).verify(input);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// request context and router

type Auth = { keyId: string; ownerId: string; email: string; prefix: string; scopes: string[] };
type Reply = { status: number; json?: unknown; html?: string; headers?: Record<string, string> };

type Ctx = {
  req: http.IncomingMessage;
  url: URL;
  method: string;
  rid: string;
  ip: string;
  base: string;
  env: Record<string, string | undefined>;
  auth: Auth | null;
  db: () => Sql;
  engine: Engine;
  json<T = Row>(schema?: z.ZodType<T>): Promise<T>;
  form(): Promise<Record<string, string>>;
};

type Handler = (c: Ctx, p: Record<string, string>) => Promise<Reply>;
type Route = { method: string; re: RegExp; keys: string[]; auth: boolean; handler: Handler };

function compile(method: string, path: string, auth: boolean, handler: Handler): Route {
  const keys: string[] = [];
  const re = new RegExp(`^${path.replace(/:([a-z_]+)/g, (_, k) => (keys.push(k), "([^/]+)"))}/?$`);
  return { method, re, keys, auth, handler };
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new ApiError(413, "payload_too_large", `The request body is larger than ${Math.round(limit / 1000)} KB.`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const errBody = (rid: string, code: string, message: string) => ({ error: { code, message, request_id: rid } });

// ---------------------------------------------------------------------------------------------------------------------
// pages

const PAGE_CSS = "body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}input,button{font:inherit;padding:.5rem .6rem;margin:.25rem 0}input{width:100%;box-sizing:border-box}button{cursor:pointer}code{background:#f2f2f2;padding:.1rem .3rem}.err{color:#a40000}.ok{color:#116611}";

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body>${body}</body></html>`;

const PAGE_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

function devicePage(userCode: string, message = "", kind: "err" | "ok" = "err", showForm = true): string {
  const form = showForm
    ? `<form method="post" action="/device" autocomplete="off">
<label>Code shown in your terminal<br><input name="user_code" value="${esc(userCode)}" placeholder="XXXX-XXXX" required maxlength="12" autocapitalize="characters"></label>
<label>Admin password<br><input name="password" type="password" required autocomplete="current-password"></label>
<button type="submit" name="action" value="approve">Approve</button> <button type="submit" name="action" value="deny">Deny</button>
</form>`
    : "";
  return page("Approve a device", `<h1>Approve a device</h1><p>Sign the Paperboy CLI in to this server. Only do this for a code you started yourself.</p>${message ? `<p class="${kind}">${esc(message)}</p>` : ""}${form}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// the server

export function createServer(opts: ServerOptions = {}): http.Server {
  const getEnv = () => opts.env ?? process.env;
  const log = opts.log ?? ((l: string) => console.log(l));
  const now = opts.now ?? Date.now;
  const engine: Engine = { ...defaultEngine(), ...opts.engine };
  const db = () => (opts.sql ? opts.sql() : (realSql() as unknown as Sql));

  const badKeys = new Limiter(60, 60_000, now);
  const deviceFails = new Limiter(8, 15 * 60_000, now);
  const deviceCreates = new Limiter(30, 60 * 60_000, now);
  const lastTouched = new Map<string, number>();
  const lastPoll = new Map<string, number>();

  const baseUrl = (req: http.IncomingMessage) => {
    const env = getEnv();
    const fixed = env.PAPERBOY_BASE_URL || env.NEXT_PUBLIC_APP_URL;
    if (fixed) return fixed.replace(/\/+$/, "");
    const host = req.headers.host || "localhost:3000";
    const proto = env.PAPERBOY_TRUST_PROXY === "1" && req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    return `${proto}://${host}`;
  };

  const clientIp = (req: http.IncomingMessage) => {
    if (getEnv().PAPERBOY_TRUST_PROXY === "1") {
      const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1];
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  // ---- auth ----
  async function authenticate(c: Pick<Ctx, "req" | "ip" | "method">): Promise<Auth> {
    if (badKeys.blocked(c.ip)) throw new ApiError(429, "rate_limited", "Too many requests with an invalid API key. Wait a minute and try again.");
    const header = c.req.headers.authorization;
    if (!header) throw new ApiError(401, "missing_api_key", "Send your API key as `Authorization: Bearer pb_live_...`.");
    const key = parseBearer(header);
    if (!key) {
      badKeys.hit(c.ip);
      throw new ApiError(401, "invalid_api_key", "That API key is not valid.");
    }
    const [row] = await db()`select k.id, k.owner_id, k.prefix, k.scopes, p.email from public.api_keys k join public.profiles p on p.id = k.owner_id
      where k.key_hash = ${sha256Hex(key)} and k.revoked_at is null`;
    if (!row) {
      badKeys.hit(c.ip);
      throw new ApiError(401, "invalid_api_key", "That API key is not valid or was revoked.");
    }
    const scopes: string[] = Array.isArray(row.scopes) ? row.scopes : ["read", "write"];
    if (c.method !== "GET" && c.method !== "HEAD" && !scopes.includes("write")) throw new ApiError(403, "insufficient_scope", "This API key is read-only.");
    const last = lastTouched.get(row.id);
    if (last === undefined || now() - last > 60_000) {
      lastTouched.set(row.id, now());
      void Promise.resolve(db()`update public.api_keys set last_used_at = now() where id = ${row.id} and (last_used_at is null or last_used_at < now() - interval '1 minute')`).catch(() => {});
    }
    return { keyId: row.id, ownerId: row.owner_id, email: row.email, prefix: row.prefix ?? keyPrefix(key), scopes };
  }

  // ---- shared lookups (always scoped to the key's owner) ----
  const need = (c: Ctx): Auth => {
    if (!c.auth) throw new ApiError(401, "missing_api_key", "Authentication required.");
    return c.auth;
  };

  async function getSite(c: Ctx, id: string): Promise<Row> {
    const auth = need(c);
    if (!UUID_RE.test(id)) throw new ApiError(404, "site_not_found", "No such site.");
    const [s] = await c.db()`select * from public.sites where id = ${id} and owner_id = ${auth.ownerId}`;
    if (!s) throw new ApiError(404, "site_not_found", "No such site.");
    return s;
  }

  const publicSite = (s: Row) => ({
    id: s.id,
    domain: s.domain,
    url: s.url,
    publish_method: s.publish_method,
    gsc_connected: !!(s.gsc_property && s.gsc_connected_at),
    plan: s.plan,
  });

  async function gscConnectUrl(c: Ctx, site: Row): Promise<string> {
    const env = c.env;
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
      throw new ApiError(501, "gsc_not_configured", "Search Console is not set up on this server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see the docs), then try again.");
    const { authUrl } = await import("@/lib/gsc");
    const { signState } = await import("@/lib/sign");
    try {
      return authUrl(signState({ k: "gsc", siteId: site.id, ownerId: site.owner_id }, 3600));
    } catch (e) {
      throw new ApiError(501, "gsc_not_configured", e instanceof Error ? e.message : "Set APP_SECRET to a long random string.");
    }
  }

  // ---- performance helpers ----
  type Day = { date: string; clicks: number; impressions: number; position: number };
  async function dailySeries(c: Ctx, siteId: string, fromDaysAgo: number, toDaysAgo: number): Promise<{ daily: Day[]; source: string }> {
    const d = c.db();
    let rows = await d`select to_char(date, 'YYYY-MM-DD') date, clicks, impressions, position from public.gsc_daily_totals
      where site_id = ${siteId} and date >= current_date - ${fromDaysAgo}::int and date <= current_date - ${toDaysAgo}::int order by date`;
    let source = "gsc_daily_totals";
    if (!rows.length) {
      // Query-level rows undercount anonymized queries, but they are what the daily pull stores for every connected site.
      rows = await d`select to_char(date, 'YYYY-MM-DD') date, sum(clicks)::int clicks, sum(impressions)::int impressions,
        coalesce(sum(position * impressions) / nullif(sum(impressions), 0), 0) position
        from public.gsc_rows where site_id = ${siteId} and date >= current_date - ${fromDaysAgo}::int and date <= current_date - ${toDaysAgo}::int group by date order by date`;
      source = "gsc_rows";
    }
    return { daily: rows.map((r) => ({ date: r.date, clicks: Number(r.clicks), impressions: Number(r.impressions), position: Number(r.position) })), source };
  }

  const totalsOf = (daily: Day[]) => {
    const clicks = daily.reduce((n, r) => n + r.clicks, 0);
    const impressions = daily.reduce((n, r) => n + r.impressions, 0);
    const weighted = impressions > 0 ? daily.reduce((n, r) => n + r.position * r.impressions, 0) / impressions : 0;
    return {
      clicks,
      impressions,
      position: Math.round(weighted * 10) / 10,
      ctr: impressions > 0 ? Math.round((clicks / impressions) * 10000) / 10000 : 0,
    };
  };

  // ---- routes ----
  const routes: Route[] = [];
  const route = (method: string, path: string, auth: boolean, handler: Handler) => routes.push(compile(method, path, auth, handler));

  route("GET", "/api/health", false, async (c) => {
    let up = false;
    try {
      await Promise.race([c.db()`select 1 as ok`, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 2500).unref())]);
      up = true;
    } catch {
      up = false;
    }
    return { status: 200, json: { ok: true, db: up, version: VERSION } };
  });

  route("GET", "/", false, async (c) => {
    const docs = c.env.PAPERBOY_DOCS_URL || "https://github.com/paperboyseo/paperboy#readme";
    return {
      status: 200,
      html: page("Paperboy", `<h1>Paperboy self-host is running</h1><p>This server has no dashboard. Use the CLI: <code>paperboy connect --self-host ${esc(c.base)}</code>.</p><p><a href="${esc(docs)}">Read the docs</a></p>`),
      headers: PAGE_HEADERS,
    };
  });

  // ---- device flow ----
  route("POST", "/api/v1/device/code", false, async (c) => {
    if (deviceCreates.blocked(c.ip)) throw new ApiError(429, "rate_limited", "Too many sign-in codes requested from this address. Try again later.");
    deviceCreates.hit(c.ip);
    await c.json(z.object({ client: z.string().max(64).optional() }).passthrough());
    const d = c.db();
    void Promise.resolve(d`delete from public.device_codes where expires_at < now() - interval '1 day'`).catch(() => {});
    const deviceCode = generateDeviceCode();
    const hash = sha256Hex(deviceCode);
    let userCode = "";
    for (let i = 0; i < 6 && !userCode; i++) {
      const candidate = generateUserCode();
      try {
        await d`insert into public.device_codes (device_hash, user_code, expires_at) values (${hash}, ${candidate}, now() + interval '10 minutes')`;
        userCode = candidate;
      } catch (e) {
        if ((e as { code?: string }).code !== "23505") throw e;
      }
    }
    if (!userCode) throw new ApiError(503, "try_again", "Could not allocate a sign-in code. Try again.");
    return {
      status: 200,
      json: {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${c.base}/device`,
        verification_uri_complete: `${c.base}/device?user_code=${encodeURIComponent(userCode)}`,
        interval: 5,
        expires_in: 600,
      },
    };
  });

  route("POST", "/api/v1/device/token", false, async (c) => {
    const body = await c.json(z.object({ device_code: z.string().min(10).max(200) }).passthrough());
    const hash = sha256Hex(body.device_code);
    const last = lastPoll.get(hash);
    lastPoll.set(hash, now());
    if (lastPoll.size > 2000) for (const [k, t] of lastPoll) if (now() - t > 15 * 60_000) lastPoll.delete(k);
    if (last !== undefined && now() - last < 3500) throw new ApiError(400, "slow_down", "You are polling too fast. Wait the full interval between requests.");
    const [row] = await c.db()`select id, owner_id, status, (expires_at < now()) as expired from public.device_codes where device_hash = ${hash}`;
    if (!row) throw new ApiError(400, "expired_token", "That sign-in code is not valid. Start again.");
    if (row.status === "denied") throw new ApiError(400, "access_denied", "The sign-in was denied.");
    if (row.status === "used" || row.expired) throw new ApiError(400, "expired_token", "That sign-in code has expired. Start again.");
    if (row.status !== "approved" || !row.owner_id) throw new ApiError(400, "authorization_pending", "Waiting for approval in the browser.");
    // Claim it atomically so a code can be exchanged exactly once.
    const [claimed] = await c.db()`update public.device_codes set status = 'used' where id = ${row.id} and status = 'approved' and expires_at > now() returning owner_id`;
    if (!claimed) throw new ApiError(400, "expired_token", "That sign-in code was already used.");
    const k = generateApiKey();
    await c.db()`insert into public.api_keys (owner_id, name, prefix, key_hash) values (${claimed.owner_id}, 'cli', ${k.prefix}, ${k.hash})`;
    lastPoll.delete(hash);
    const [owner] = await c.db()`select email from public.profiles where id = ${claimed.owner_id}`;
    return { status: 200, json: { api_key: k.key, token_type: "bearer", key_prefix: k.prefix, owner: { id: claimed.owner_id, email: owner?.email ?? null } } };
  });

  route("GET", "/device", false, async (c) => ({
    status: 200,
    html: devicePage(normalizeUserCode(c.url.searchParams.get("user_code") ?? "") ?? (c.url.searchParams.get("user_code") ?? "").slice(0, 12)),
    headers: PAGE_HEADERS,
  }));

  route("POST", "/device", false, async (c) => {
    const reply = (status: number, code: string, msg: string, kind: "err" | "ok" = "err", form = true): Reply => ({ status, html: devicePage(code, msg, kind, form), headers: PAGE_HEADERS });
    const f = await c.form();
    const typed = (f.user_code ?? "").slice(0, 12);
    if (deviceFails.blocked(c.ip)) return reply(429, typed, "Too many failed attempts. Wait 15 minutes and try again.");
    const adminPassword = c.env.PAPERBOY_ADMIN_PASSWORD;
    const adminEmail = c.env.PAPERBOY_ADMIN_EMAIL;
    if (!adminPassword || !adminEmail) return reply(503, typed, "This server has no admin account. Set PAPERBOY_ADMIN_EMAIL and PAPERBOY_ADMIN_PASSWORD and run the seed script.", "err", false);
    const fail = (status: number, msg: string) => {
      deviceFails.hit(c.ip);
      return reply(status, typed, msg);
    };
    if (!safeEqual(f.password ?? "", adminPassword)) return fail(401, "That password is not right.");
    const code = normalizeUserCode(typed);
    if (!code) return fail(400, "That code does not look right. It has the form XXXX-XXXX.");
    const [owner] = await c.db()`select id from public.profiles where lower(email) = lower(${adminEmail})`;
    if (!owner) return reply(409, typed, "The admin account does not exist yet. Run the seed script first.", "err", false);
    const deny = f.action === "deny";
    const [updated] = await c.db()`update public.device_codes set status = ${deny ? "denied" : "approved"}, owner_id = ${owner.id}
      where user_code = ${code} and status = 'pending' and expires_at > now() returning id`;
    if (!updated) return fail(400, "That code is not valid, has expired, or was already used.");
    return reply(200, "", deny ? "Denied. You can close this tab." : "Approved. Return to your terminal, the CLI signs in within a few seconds.", "ok", false);
  });

  // ---- account ----
  route("GET", "/api/v1/me", true, async (c) => {
    const a = need(c);
    return { status: 200, json: { owner: { id: a.ownerId, email: a.email }, credits: { enabled: false }, key: { prefix: a.prefix } } };
  });

  // ---- sites ----
  route("GET", "/api/v1/sites", true, async (c) => {
    const a = need(c);
    const rows = await c.db()`select * from public.sites where owner_id = ${a.ownerId} order by created_at`;
    return { status: 200, json: { sites: rows.map(publicSite) } };
  });

  route("POST", "/api/v1/sites", true, async (c) => {
    const a = need(c);
    const body = await c.json(z.object({ url: z.string().min(3).max(500), publish_method: z.enum(["hosted", "prompt", "wordpress", "ghost", "webhook"]).optional() }));
    const { normalizeUrl, domainOf, slugify } = await import("@/lib/util");
    const url = normalizeUrl(body.url);
    if (!url) throw new ApiError(400, "invalid_url", "That does not look like a website address. Example: https://example.com");
    const domain = domainOf(url);
    const [dupe] = await c.db()`select * from public.sites where owner_id = ${a.ownerId} and domain = ${domain} limit 1`;
    if (dupe) {
      let link: string | undefined;
      if (!dupe.gsc_connected_at) link = await gscConnectUrl(c, dupe).catch(() => undefined);
      return { status: 200, json: { site: publicSite(dupe), ...(link ? { gsc_connect_url: link } : {}) } };
    }
    // Reading the site is best effort: an unreachable site is still added, and the scan can be filled in later.
    let scan: Row = { url, domain, name: domain };
    try {
      const s = await Promise.race([engine.scanSite(url), new Promise<null>((r) => setTimeout(() => r(null), 30_000).unref())]);
      if (s) scan = s;
    } catch (e) {
      log(`[server] scan of ${domain} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const plan = ["free", "starter", "growth", "pro"].includes(c.env.PAPERBOY_DEFAULT_PLAN ?? "") ? c.env.PAPERBOY_DEFAULT_PLAN! : "starter";
    const slug = `${slugify(domain, 50) || "site"}-${randomBytes(3).toString("hex")}`;
    const d = c.db();
    const json = (v: unknown) => (typeof (d as any).json === "function" ? (d as any).json(v) : JSON.stringify(v));
    const [site] = await d`insert into public.sites (owner_id, url, domain, name, slug, scan, cta_text, cta_url, publish_method, plan, subscription_status)
      values (${a.ownerId}, ${url}, ${domain}, ${String(scan.name || domain).slice(0, 200)}, ${slug}, ${json(scan)}, ${String(scan.cta_text ?? "").slice(0, 200)},
        ${String(scan.cta_url ?? url).slice(0, 500)}, ${body.publish_method ?? c.env.PAPERBOY_PUBLISH_METHOD ?? "hosted"}, ${plan}, ${plan === "free" ? null : "active"})
      returning *`;
    const link = await gscConnectUrl(c, site).catch(() => undefined);
    return { status: 201, json: { site: publicSite(site), ...(link ? { gsc_connect_url: link } : {}) } };
  });

  route("GET", "/api/v1/sites/:id", true, async (c, p) => ({ status: 200, json: { site: publicSite(await getSite(c, p.id)) } }));

  route("POST", "/api/v1/sites/:id/gsc/connect", true, async (c, p) => ({ status: 200, json: { url: await gscConnectUrl(c, await getSite(c, p.id)) } }));

  // Google redirects here after consent. The signed state names the site and its owner, so no API key is needed.
  route("GET", "/api/gsc/callback", false, async (c) => {
    const result = (status: number, msg: string): Reply => ({ status, html: page("Search Console", `<h1>Search Console</h1><p>${esc(msg)}</p>`), headers: PAGE_HEADERS });
    if (c.url.searchParams.get("error")) return result(400, "Google did not grant access. You can close this tab and run the connect step again.");
    const code = c.url.searchParams.get("code") ?? "";
    let state: { k?: string; siteId?: string; ownerId?: string } | null = null;
    try {
      state = (await import("@/lib/sign")).readState(c.url.searchParams.get("state") ?? "");
    } catch {
      state = null;
    }
    if (!code || !state || state.k !== "gsc" || !state.siteId || !state.ownerId || !UUID_RE.test(state.siteId)) return result(400, "This link is not valid or has expired. Start the connect step again.");
    const [site] = await c.db()`select * from public.sites where id = ${state.siteId} and owner_id = ${state.ownerId}`;
    if (!site) return result(404, "That site no longer exists.");
    try {
      const gsc = await import("@/lib/gsc");
      const tokens = await gsc.exchangeCode(code);
      if (!tokens.refresh_token) return result(400, "Google did not return a refresh token. Remove Paperboy from your Google account permissions and connect again.");
      const prop = gsc.matchProperty(await gsc.listProperties(tokens.access_token), site.url);
      if (!prop) return result(400, `Your Google account has no Search Console property for ${site.domain}. Add and verify it in Search Console, then connect again.`);
      await c.db()`insert into public.site_secrets (site_id, owner_id, gsc_refresh_token) values (${site.id}, ${site.owner_id}, ${tokens.refresh_token})
        on conflict (site_id) do update set gsc_refresh_token = excluded.gsc_refresh_token, updated_at = now()`;
      await c.db()`update public.sites set gsc_property = ${prop.siteUrl}, gsc_connected_at = now(), gsc_skipped = false, gsc_error = null where id = ${site.id} and owner_id = ${site.owner_id}`;
      void import("@/lib/jobs").then((j) => j.runJob("gsc-site", { siteId: site.id })).catch((e) => log(`[server] first Search Console pull failed: ${e instanceof Error ? e.message : String(e)}`));
      return result(200, `Search Console is connected for ${site.domain}. You can close this tab.`);
    } catch (e) {
      log(`[server] gsc callback failed: ${e instanceof Error ? e.message : String(e)}`);
      return result(502, "Could not finish the Google connection. Check the server log and try again.");
    }
  });

  // ---- topics and articles ----
  route("POST", "/api/v1/sites/:id/topics", true, async (c, p) => {
    const a = need(c);
    const body = await c.json(z.object({ n: z.union([z.number(), z.string()]).optional() }).passthrough());
    const n = clampInt(body.n, 1, 10, 3);
    const site = await getSite(c, p.id);
    const d = c.db();
    // Reuse suggestions that are still open, then ask for the rest.
    const picked: { id: string; title: string; query: string; reason: string }[] = (
      await d`select id, text, target_query, reason from public.topic_ideas where site_id = ${site.id} and owner_id = ${a.ownerId} and status = 'open' and kind = 'suggested'
        order by created_at limit ${n}`
    ).map((r) => ({ id: r.id, title: r.text, query: r.target_query ?? r.text, reason: r.reason ?? "" }));
    if (picked.length < n) {
      for (const t of await engine.suggestTopics(site, n - picked.length)) {
        const [row] = await d`insert into public.topic_ideas (site_id, owner_id, kind, text, target_query, angle, intent, reason)
          values (${site.id}, ${a.ownerId}, 'suggested', ${t.topic}, ${t.target_query}, ${t.angle ?? null}, ${t.intent ?? null}, ${t.reason ?? null}) returning id`;
        picked.push({ id: row.id, title: t.topic, query: t.target_query, reason: t.reason ?? "" });
      }
    }
    const topics = await Promise.all(
      picked.map(async (t) => {
        const sig = await engine.topicSignals(site.id, t.query).catch(() => ({ impressions: null, position: null }));
        const [gate] = await Promise.resolve(
          d`select decision, strong_count, total from public.serp_gate_log where site_id = ${site.id} and lower(target_query) = lower(${t.query}) order by created_at desc limit 1`,
        ).catch(() => [] as Row[]);
        return {
          ...t,
          signals: { impressions: sig.impressions, position: sig.position, serp_gate: gate ? { decision: gate.decision, strong: gate.strong_count, total: gate.total } : null },
        };
      }),
    );
    return { status: 200, json: { topics } };
  });

  route("POST", "/api/v1/sites/:id/articles", true, async (c, p) => {
    const a = need(c);
    const body = await c.json(z.object({ topic_id: z.string().optional(), topic: z.string().min(3).max(300).optional(), publish: z.boolean().optional() }).passthrough());
    if (!body.topic_id && !body.topic) throw new ApiError(400, "invalid_request", "Send topic_id (from the topics list) or topic (your own title or idea).");
    const site = await getSite(c, p.id);
    const d = c.db();
    const [busy] = await d`select count(*)::int n from public.articles where site_id = ${site.id} and owner_id = ${a.ownerId} and status in ('planned', 'picking', 'researching', 'writing', 'checking', 'fixing', 'publishing')`;
    if (Number(busy?.n ?? 0) >= 5) throw new ApiError(429, "too_many_in_flight", "This site already has 5 articles in progress. Wait for one to finish.");
    let idea: Row | undefined;
    if (body.topic_id) {
      if (!UUID_RE.test(body.topic_id)) throw new ApiError(404, "topic_not_found", "No such topic.");
      [idea] = await d`select * from public.topic_ideas where id = ${body.topic_id} and site_id = ${site.id} and owner_id = ${a.ownerId} and kind in ('idea', 'suggested')`;
      if (!idea) throw new ApiError(404, "topic_not_found", "No such topic for this site.");
      if (idea.status === "used") throw new ApiError(409, "topic_used", "That topic already became an article.");
    }
    const text = String(idea?.text ?? body.topic).trim();
    const [art] = await d`insert into public.articles (site_id, owner_id, status, kind, topic, target_query, angle, intent, reason)
      values (${site.id}, ${a.ownerId}, 'planned', 'new', ${text}, ${idea?.target_query ?? text}, ${idea?.angle ?? ""}, ${idea?.intent ?? "learning"},
        ${idea?.reason ?? "Requested through the API."}) returning id`;
    if (idea) await d`update public.topic_ideas set status = 'used', article_id = ${art.id} where id = ${idea.id} and owner_id = ${a.ownerId}`;
    // Start it now; the worker also claims any planned article, and the pipeline's lock keeps the two from clashing.
    await engine.kickArticle(art.id).catch((e) => log(`[server] could not start article ${art.id}: ${e instanceof Error ? e.message : String(e)}`));
    return { status: 202, json: { job_id: art.id, article_id: art.id } };
  });

  route("GET", "/api/v1/jobs/:id", true, async (c, p) => {
    const a = need(c);
    if (!UUID_RE.test(p.id)) throw new ApiError(404, "job_not_found", "No such job.");
    const d = c.db();
    const [art] = await d`select id, status, step_note, review_reason, review_note from public.articles where id = ${p.id} and owner_id = ${a.ownerId}`;
    if (art) {
      const s = String(art.status);
      let status: "queued" | "running" | "done" | "failed" = "running";
      if (s === "planned") status = "queued";
      else if (s === "published") status = "done";
      else if (s === "failed") status = "failed";
      else if (s === "needs_review") status = art.review_reason === "approval" ? "done" : "failed";
      const out: Row = { id: art.id, status, article_id: art.id };
      if (art.step_note) out.step = art.step_note;
      else if (s === "needs_review" && status === "done") out.step = "Passed the fact check, waiting for approval to publish";
      if (status === "failed" || (s === "planned" && art.review_note)) out.error = art.review_note || "The article could not be finished.";
      return { status: 200, json: out };
    }
    const [job] = await d`select id, status, result, error from public.api_jobs where id = ${p.id} and owner_id = ${a.ownerId}`;
    if (!job) throw new ApiError(404, "job_not_found", "No such job.");
    return { status: 200, json: { id: job.id, status: job.status, ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}) } };
  });

  route("GET", "/api/v1/articles/:id", true, async (c, p) => {
    const a = need(c);
    if (!UUID_RE.test(p.id)) throw new ApiError(404, "article_not_found", "No such article.");
    const d = c.db();
    const [art] = await d`select id, title, status, published_url, body_md, review_reason, review_note, step_note from public.articles where id = ${p.id} and owner_id = ${a.ownerId}`;
    if (!art) throw new ApiError(404, "article_not_found", "No such article.");
    const [v] = await d`select score, pass, summary, judge, checks from public.quality_verdicts where article_id = ${art.id} and owner_id = ${a.ownerId} order by round desc, created_at desc limit 1`;
    const verdict = v
      ? {
          pass: !!v.pass,
          score: Number(v.score),
          summary: v.summary ?? "",
          checks: simplifyChecks(verdictToChecks({ pass: !!v.pass, score: Number(v.score), summary: v.summary ?? "", judge: v.judge ?? "", checks: Array.isArray(v.checks) ? v.checks : [] }, art.body_md ?? "")),
        }
      : null;
    return {
      status: 200,
      json: { id: art.id, title: art.title, status: art.status, url: art.published_url ?? null, verdict, ...(art.review_note ? { review_note: art.review_note } : {}) },
    };
  });

  route("POST", "/api/v1/articles/:id/publish", true, async (c, p) => {
    const a = need(c);
    if (!UUID_RE.test(p.id)) throw new ApiError(404, "article_not_found", "No such article.");
    const body = await c.json(z.object({ force: z.boolean().optional() }).passthrough());
    const [art] = await c.db()`select id, status, review_reason, published_url from public.articles where id = ${p.id} and owner_id = ${a.ownerId}`;
    if (!art) throw new ApiError(404, "article_not_found", "No such article.");
    if (art.status === "published") return { status: 200, json: { published: true, url: art.published_url ?? null } };
    if (art.status === "needs_review" && art.review_reason === "quality" && !body.force)
      throw new ApiError(409, "fact_check_failed", "This article did not pass the fact check. Fix it, or send {\"force\": true} to publish it anyway.");
    const r = await engine.finalizePublish(art.id);
    if (!r.ok) throw new ApiError(409, "not_publishable", r.message);
    const [after] = await c.db()`select published_url from public.articles where id = ${art.id} and owner_id = ${a.ownerId}`;
    return { status: 200, json: { published: true, url: after?.published_url ?? null } };
  });

  // ---- fact check and verify ----
  const SourceIn = z.union([z.string().url(), z.object({ url: z.string().url(), text: z.string().max(400_000).optional(), title: z.string().max(300).optional() })]);
  route("POST", "/api/v1/fact-check", true, async (c) => {
    const a = need(c);
    const body = await c.json(
      z
        .object({ url: z.string().url().max(2000).optional(), markdown: z.string().min(1).max(500_000).optional(), sources: z.array(SourceIn).max(30).optional() })
        .refine((b) => !!b.url || !!b.markdown, { message: "Send url or markdown." }),
    );
    let markdown = body.markdown ?? "";
    let title = "";
    let own = "";
    if (body.url) {
      try {
        const pg = await engine.fetchPage(body.url, 20_000);
        markdown = htmlToMarkdown(pg.html, pg.finalUrl);
        title = pg.title;
        own = hostOfUrl(pg.finalUrl);
      } catch (e) {
        throw new ApiError(422, "url_unreadable", e instanceof Error ? e.message : "That page could not be read.");
      }
      if (markdown.length < 40) throw new ApiError(422, "url_unreadable", "No article text was found on that page.");
    }
    title = title || titleOfMarkdown(markdown);

    const provided = new Map<string, QualitySource>();
    const toFetch: string[] = [];
    for (const s of body.sources ?? []) {
      if (typeof s === "string") toFetch.push(s);
      else if (s.text) provided.set(s.url, { url: s.url, title: s.title, text: s.text });
      else toFetch.push(s.url);
    }
    for (const u of extractLinks(markdown)) if (hostOfUrl(u) !== own || !own) toFetch.push(u);
    const urls = [...new Set(toFetch)].filter((u) => !provided.has(u)).slice(0, 25);
    const unreadable = new Map<string, string>();
    const fetched = await mapLimit(urls, 4, async (u) => {
      try {
        const pg = await engine.fetchPage(u, 12_000);
        return { url: u, title: pg.title, text: pg.text.slice(0, 80_000) } as QualitySource;
      } catch (e) {
        unreadable.set(u, e instanceof Error ? e.message : "it did not load");
        return null;
      }
    });
    const sources = [...provided.values(), ...fetched.filter((s): s is QualitySource => !!s && s.text.length > 0)];
    for (const s of fetched) if (s && !s.text.length) unreadable.set(s.url, "the page had no readable text");

    const input: QualityInput = { article: { title, bodyMarkdown: markdown, faq: [] }, sources, ownHosts: own ? [own] : [] };
    const verdict = await engine.verify(input, { ownerId: a.ownerId });
    const checks = verdictToChecks(verdict, markdown, { unreadable });
    return {
      status: 200,
      json: {
        pass: verdict.pass,
        score: verdict.score,
        claims_total: checks.length,
        claims_verified: checks.filter((x) => x.status === "verified").length,
        checks,
        summary: verdict.summary,
        judge: verdict.judge,
      },
    };
  });

  const VerifyIn = z.object({
    article: z.object({ title: z.string().max(500), bodyMarkdown: z.string().max(500_000), faq: z.array(z.object({ q: z.string(), a: z.string() })).optional() }),
    sources: z.array(z.object({ url: z.string().max(2000), title: z.string().max(500).optional(), text: z.string().max(500_000), selling: z.boolean().optional() })).max(60),
    voice: z.object({ description: z.string().optional(), interview: z.array(z.object({ q: z.string(), a: z.string() })).optional(), wordsToAvoid: z.array(z.string()).optional() }).optional(),
    bannedClaims: z.array(z.string()).max(200).optional(),
    ownHosts: z.array(z.string()).max(20).optional(),
  });
  route("POST", "/api/v1/verify", true, async (c) => {
    const a = need(c);
    const input = (await c.json(VerifyIn)) as QualityInput;
    return { status: 200, json: { verdict: await engine.verify(input, { ownerId: a.ownerId, local: true }) } };
  });

  // ---- performance and reports ----
  route("GET", "/api/v1/sites/:id/performance", true, async (c, p) => {
    const site = await getSite(c, p.id);
    const days = clampInt(c.url.searchParams.get("days"), 1, 365, 28);
    const { daily } = await dailySeries(c, site.id, days, 0);
    return { status: 200, json: { days, totals: totalsOf(daily), daily: daily.map((r) => ({ date: r.date, clicks: r.clicks, impressions: r.impressions })) } };
  });

  route("POST", "/api/v1/sites/:id/reports", true, async (c, p) => {
    const a = need(c);
    const site = await getSite(c, p.id);
    const body = await c.json(z.object({ days: z.union([z.number(), z.string()]).optional() }).passthrough());
    const days = clampInt(body.days, 1, 365, 28);
    const d = c.db();
    const { daily, source } = await dailySeries(c, site.id, days, 0);
    const prev = totalsOf((await dailySeries(c, site.id, days * 2, days + 1)).daily);
    const totals = totalsOf(daily);
    const pages = await d`select page, sum(clicks)::int clicks, sum(impressions)::int impressions from public.gsc_rows
      where site_id = ${site.id} and owner_id = ${a.ownerId} and date >= current_date - ${days}::int group by page order by sum(clicks) desc, sum(impressions) desc limit 10`;
    const queries = await d`select query, sum(clicks)::int clicks, sum(impressions)::int impressions,
        coalesce(sum(position * impressions) / nullif(sum(impressions), 0), 0) position
      from public.gsc_rows where site_id = ${site.id} and owner_id = ${a.ownerId} and date >= current_date - ${days}::int group by query order by sum(clicks) desc, sum(impressions) desc limit 10`;
    const published = await d`select title, published_url, published_at from public.articles where site_id = ${site.id} and owner_id = ${a.ownerId} and status = 'published'
      and published_at >= now() - (${days}::int * interval '1 day') order by published_at desc`;
    const delta = (now: number, before: number) => (before > 0 ? ` (${now >= before ? "+" : ""}${Math.round(((now - before) / before) * 100)}% vs the previous ${days} days)` : "");
    const lines = [
      `# ${site.domain}: last ${days} days`,
      "",
      `- Clicks: ${totals.clicks}${delta(totals.clicks, prev.clicks)}`,
      `- Impressions: ${totals.impressions}${delta(totals.impressions, prev.impressions)}`,
      `- Average position: ${totals.position || "n/a"}`,
      `- Click-through rate: ${(totals.ctr * 100).toFixed(1)}%`,
      "",
      `## Published (${published.length})`,
      ...(published.length ? published.map((r) => `- [${r.title}](${r.published_url})`) : ["- Nothing published in this period."]),
      "",
      "## Top pages",
      ...(pages.length ? pages.map((r) => `- ${r.page}: ${r.clicks} clicks, ${r.impressions} impressions`) : ["- No page data yet."]),
      "",
      "## Top queries",
      ...(queries.length ? queries.map((r) => `- ${r.query}: ${r.clicks} clicks, ${r.impressions} impressions, position ${Math.round(Number(r.position) * 10) / 10}`) : ["- No query data yet."]),
    ];
    return {
      status: 200,
      json: {
        markdown: lines.join("\n"),
        data: { site: publicSite(site), days, source, totals, previous: prev, daily, top_pages: pages, top_queries: queries, published },
      },
    };
  });

  // ---- dispatch ----
  async function dispatch(req: http.IncomingMessage, res: http.ServerResponse) {
    const started = now();
    const rid = requestId();
    const method = (req.method ?? "GET").toUpperCase();
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return send(res, rid, { status: 400, json: errBody(rid, "bad_request", "Bad request URL.") });
    }
    const path = url.pathname.replace(/\/+$/, "") || "/";
    let auth: Auth | null = null;
    let status = 500;
    const ctx: Ctx = {
      req,
      url,
      method,
      rid,
      ip: clientIp(req),
      base: baseUrl(req),
      env: getEnv(),
      auth: null,
      db,
      engine,
      async json(schema) {
        const raw = await readBody(req, MAX_JSON_BYTES);
        let data: unknown = {};
        if (raw.trim()) {
          try {
            data = JSON.parse(raw);
          } catch {
            throw new ApiError(400, "invalid_json", "The request body is not valid JSON.");
          }
        }
        if (!schema) return data as never;
        const r = schema.safeParse(data);
        if (!r.success) {
          const first = r.error.issues[0];
          throw new ApiError(400, "invalid_request", `${first?.path.join(".") || "body"}: ${first?.message ?? "invalid"}`);
        }
        return r.data;
      },
      async form() {
        const raw = await readBody(req, MAX_FORM_BYTES);
        return Object.fromEntries(new URLSearchParams(raw).entries());
      },
    };
    try {
      const match = routes.map((r) => ({ r, m: r.re.exec(path) })).filter((x) => x.m);
      const hit = match.find((x) => x.r.method === method);
      if (!hit) {
        if (match.length) throw new ApiError(405, "method_not_allowed", `${method} is not allowed on ${path}.`);
        throw new ApiError(404, "not_found", `No route for ${method} ${path}.`);
      }
      if (hit.r.auth) {
        auth = await authenticate(ctx);
        ctx.auth = auth;
      }
      const params: Record<string, string> = {};
      try {
        hit.r.keys.forEach((k, i) => (params[k] = decodeURIComponent(hit.m![i + 1])));
      } catch {
        throw new ApiError(400, "bad_request", "Bad request URL.");
      }
      const reply = await hit.r.handler(ctx, params);
      status = reply.status;
      send(res, rid, reply);
    } catch (e) {
      const err = toApiError(e, log, rid);
      status = err.status;
      send(res, rid, { status: err.status, json: errBody(rid, err.code, err.message), headers: err.status === 429 ? { "Retry-After": "60" } : undefined });
    }
    if (auth && path.startsWith("/api/")) {
      const a = auth;
      const ms = now() - started;
      void Promise.resolve(db()`insert into public.api_usage (api_key_id, owner_id, method, path, status, ms) values (${a.keyId}, ${a.ownerId}, ${method}, ${path.slice(0, 200)}, ${status}, ${ms})`).catch(() => {});
    }
  }

  return http.createServer((req, res) => {
    dispatch(req, res).catch((e) => {
      log(`[server] unhandled: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
}

function toApiError(e: unknown, log: (l: string) => void, rid: string): ApiError {
  if (e instanceof ApiError) return e;
  const name = (e as { constructor?: { name?: string } } | null)?.constructor?.name;
  const msg = e instanceof Error ? e.message : String(e);
  if (name === "AiNotConfigured") return new ApiError(503, "ai_not_configured", "No model key is set on this server. Set ANTHROPIC_API_KEY and restart it.");
  if (name === "CapReached") return new ApiError(402, "cost_cap", msg);
  if (name === "Refused") return new ApiError(422, "refused", msg);
  if (name === "FetchError") return new ApiError(422, "fetch_failed", msg);
  log(`[server] ${rid} error: ${e instanceof Error ? (e.stack ?? msg) : msg}`);
  return new ApiError(500, "internal_error", "Something went wrong on the server. Check the server log with this request id.");
}

function send(res: http.ServerResponse, rid: string, reply: Reply) {
  if (res.headersSent) return;
  const headers: Record<string, string> = { "x-request-id": rid, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...(reply.headers ?? {}) };
  if (reply.html !== undefined) {
    headers["Content-Type"] = "text/html; charset=utf-8";
    res.writeHead(reply.status, headers).end(reply.html);
    return;
  }
  headers["Content-Type"] = "application/json; charset=utf-8";
  res.writeHead(reply.status, headers).end(JSON.stringify(reply.json ?? {}));
}

// ---------------------------------------------------------------------------------------------------------------------
// run directly: `tsx src/server/server.ts`

export function startServer(opts: ServerOptions & { port?: number } = {}): http.Server {
  const port = opts.port ?? Number(process.env.PORT || 3000);
  const server = createServer(opts);
  server.listen(port, "0.0.0.0", () => console.log(`[server] Paperboy ${VERSION} listening on http://0.0.0.0:${port}`));
  const stop = () => {
    console.log("[server] shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startServer();
