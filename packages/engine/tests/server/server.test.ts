// SPDX-License-Identifier: AGPL-3.0-only
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Engine } from "@/server/server";
import { generateApiKey, sha256Hex, USER_CODE_RE } from "@/server/keys";
import { fakeSql } from "./fake-sql";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SITE = "33333333-3333-4333-8333-333333333333";
const ART = "44444444-4444-4444-8444-444444444444";

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function boot(opts: { rules?: Parameters<typeof fakeSql>[0]; engine?: Partial<Engine>; env?: Record<string, string>; now?: () => number } = {}) {
  const db = fakeSql(opts.rules);
  const key = generateApiKey();
  // The key lookup: only the hash of `key` belongs to OWNER.
  db.on(/from public\.api_keys k join public\.profiles/, (v) =>
    v[0] === key.hash ? [{ id: "k1", owner_id: OWNER, prefix: key.prefix, scopes: ["read", "write"], email: "op@example.com" }] : [],
  );
  const server = createServer({ sql: () => db.sql, engine: opts.engine, env: opts.env ?? {}, log: () => {}, now: opts.now });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, init: { body?: unknown; key?: string | null; headers?: Record<string, string>; raw?: string } = {}) => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.key !== null) headers.Authorization = `Bearer ${init.key ?? key.key}`;
    if (init.body !== undefined || init.raw !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(base + path, { method, headers, body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)) });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { db, key, base, call };
}

describe("public routes", () => {
  it("answers /api/health with db false when there is no database", async () => {
    const s = createServer({ sql: () => { throw new Error("no database"); }, env: {}, log: () => {} });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/health`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, db: false });
    expect(typeof body.version).toBe("string");
  });

  it("answers /api/health with db true when a query works", async () => {
    const { call } = await boot();
    const r = await call("GET", "/api/health", { key: null });
    expect(r.json.db).toBe(true);
  });

  it("serves a plain page at /", async () => {
    const { call } = await boot();
    const r = await call("GET", "/", { key: null });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    expect(r.text).toContain("Paperboy self-host is running");
    expect(r.text).toMatch(/<a href="https?:\/\/[^"]+">Read the docs<\/a>/);
  });
});

describe("error shape", () => {
  it("returns {error:{code,message,request_id}} for unknown routes", async () => {
    const { call } = await boot();
    const r = await call("GET", "/api/v1/nope", { key: null });
    expect(r.status).toBe(404);
    expect(r.json.error).toMatchObject({ code: "not_found" });
    expect(r.json.error.message).toEqual(expect.any(String));
    expect(r.json.error.request_id).toMatch(/^req_[0-9a-f]{16}$/);
    expect(r.headers.get("x-request-id")).toBe(r.json.error.request_id);
  });

  it("returns 405 for a known path with the wrong method", async () => {
    const { call } = await boot();
    const r = await call("DELETE", "/api/v1/me");
    expect(r.status).toBe(405);
    expect(r.json.error.code).toBe("method_not_allowed");
  });

  it("returns invalid_json for a broken body", async () => {
    const { call } = await boot();
    const r = await call("POST", "/api/v1/sites", { raw: "{nope" });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("invalid_json");
  });

  it("returns invalid_request for a body that fails validation", async () => {
    const { call } = await boot();
    const r = await call("POST", "/api/v1/sites", { body: { url: 5 } });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("invalid_request");
  });

  it("hides internal errors behind a request id", async () => {
    const { call, db } = await boot();
    db.on(/from public\.sites where owner_id/, () => {
      throw new Error("secret connection string");
    });
    const r = await call("GET", "/api/v1/sites");
    expect(r.status).toBe(500);
    expect(r.json.error.code).toBe("internal_error");
    expect(r.text).not.toContain("secret");
  });
});

describe("auth", () => {
  it("rejects a missing key and never touches the database", async () => {
    const { call, db } = await boot();
    const r = await call("GET", "/api/v1/me", { key: null });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("missing_api_key");
    expect(db.calls).toHaveLength(0);
  });

  it("rejects a malformed key without a database lookup", async () => {
    const { call, db } = await boot();
    const r = await call("GET", "/api/v1/me", { key: "not-a-key" });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("invalid_api_key");
    expect(db.calls).toHaveLength(0);
  });

  it("rejects an unknown key", async () => {
    const { call, db } = await boot();
    const other = generateApiKey();
    const r = await call("GET", "/api/v1/me", { key: other.key });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("invalid_api_key");
    expect(db.calls[0].values[0]).toBe(sha256Hex(other.key));
    expect(db.calls[0].text).toContain("revoked_at is null");
  });

  it("accepts the right key and answers /me", async () => {
    const { call, key } = await boot();
    const r = await call("GET", "/api/v1/me");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ owner: { id: OWNER, email: "op@example.com" }, credits: { enabled: false }, key: { prefix: key.prefix } });
  });

  it("records usage and touches last_used_at at most once a minute", async () => {
    let t = 1_000_000;
    const { call, db } = await boot({ now: () => t });
    await call("GET", "/api/v1/me");
    await call("GET", "/api/v1/me");
    await new Promise((r) => setTimeout(r, 30));
    expect(db.find(/update public\.api_keys set last_used_at/)).toHaveLength(1);
    expect(db.find(/insert into public\.api_usage/)).toHaveLength(2);
    t += 61_000;
    await call("GET", "/api/v1/me");
    await new Promise((r) => setTimeout(r, 30));
    expect(db.find(/update public\.api_keys set last_used_at/)).toHaveLength(2);
  });

  it("rejects writes from a read-only key", async () => {
    const { call, db } = await boot();
    db.on(/from public\.api_keys k join public\.profiles/, [{ id: "k2", owner_id: OWNER, prefix: "pb_live_xxxx", scopes: ["read"], email: "op@example.com" }]);
    const r = await call("POST", "/api/v1/sites", { body: { url: "example.com" } });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("insufficient_scope");
  });

  it("rate limits repeated bad keys per address", async () => {
    const { call } = await boot();
    for (let i = 0; i < 60; i++) await call("GET", "/api/v1/me", { key: "bad" });
    const r = await call("GET", "/api/v1/me", { key: "bad" });
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe("rate_limited");
  });
});

describe("owner scoping", () => {
  it("filters every site query by the key's owner", async () => {
    const { call, db } = await boot();
    db.on(/from public\.sites where id = \? and owner_id = \?/, (v) => (v[0] === SITE && v[1] === OWNER ? [{ id: SITE, domain: "example.com", url: "https://example.com", publish_method: "hosted", plan: "starter", gsc_property: null }] : []));
    const ok = await call("GET", `/api/v1/sites/${SITE}`);
    expect(ok.status).toBe(200);
    expect(ok.json.site).toEqual({ id: SITE, domain: "example.com", url: "https://example.com", publish_method: "hosted", gsc_connected: false, plan: "starter" });
    const q = db.find(/from public\.sites where id/)[0];
    expect(q.values).toEqual([SITE, OWNER]);
    // Another owner's key gets the same answer as a missing site.
    const missing = await call("GET", "/api/v1/sites/55555555-5555-4555-8555-555555555555");
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe("site_not_found");
    const bad = await call("GET", "/api/v1/sites/not-a-uuid");
    expect(bad.status).toBe(404);
  });

  it("scopes list, article and job lookups by owner", async () => {
    const { call, db } = await boot();
    await call("GET", "/api/v1/sites");
    await call("GET", `/api/v1/articles/${ART}`);
    await call("GET", `/api/v1/jobs/${ART}`);
    for (const re of [/from public\.sites where owner_id/, /from public\.articles where id = \? and owner_id = \?/]) {
      const c = db.find(re)[0];
      expect(c, String(re)).toBeTruthy();
      expect(c.values).toContain(OWNER);
    }
    expect(OTHER).not.toBe(OWNER);
  });
});

describe("jobs and articles", () => {
  const status = (s: string, extra: Record<string, unknown> = {}) => [{ id: ART, status: s, step_note: null, review_reason: null, review_note: null, ...extra }];

  it.each([
    ["planned", "queued"],
    ["researching", "running"],
    ["writing", "running"],
    ["published", "done"],
    ["failed", "failed"],
  ])("maps article status %s to job status %s", async (art, job) => {
    const { call, db } = await boot();
    db.on(/select id, status, step_note/, status(art, art === "researching" ? { step_note: "Reading sources" } : {}));
    const r = await call("GET", `/api/v1/jobs/${ART}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: ART, status: job, article_id: ART });
    if (art === "researching") expect(r.json.step).toBe("Reading sources");
  });

  it("treats needs_review for approval as done and for quality as failed", async () => {
    const { call, db } = await boot();
    db.on(/select id, status, step_note/, status("needs_review", { review_reason: "approval" }));
    expect((await call("GET", `/api/v1/jobs/${ART}`)).json.status).toBe("done");
    db.on(/select id, status, step_note/, status("needs_review", { review_reason: "quality", review_note: "Fact check failed" }));
    const r = await call("GET", `/api/v1/jobs/${ART}`);
    expect(r.json).toMatchObject({ status: "failed", error: "Fact check failed" });
  });

  it("falls back to api_jobs and then 404", async () => {
    const { call, db } = await boot();
    const none = await call("GET", `/api/v1/jobs/${ART}`);
    expect(none.status).toBe(404);
    db.on(/from public\.api_jobs/, [{ id: ART, status: "running", result: null, error: null }]);
    const r = await call("GET", `/api/v1/jobs/${ART}`);
    expect(r.json).toEqual({ id: ART, status: "running" });
  });

  it("creates a planned article, kicks it and returns 202 with job_id equal to article_id", async () => {
    const kickArticle = vi.fn(async () => {});
    const { call, db } = await boot({ engine: { kickArticle } });
    db.on(/from public\.sites where id = \? and owner_id = \?/, [{ id: SITE, owner_id: OWNER, domain: "example.com" }]);
    db.on(/select count\(\*\)::int n from public\.articles/, [{ n: 0 }]);
    db.on(/insert into public\.articles/, [{ id: ART }]);
    const r = await call("POST", `/api/v1/sites/${SITE}/articles`, { body: { topic: "How much does a website cost?", publish: true } });
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ job_id: ART, article_id: ART });
    expect(kickArticle).toHaveBeenCalledWith(ART);
    const ins = db.find(/insert into public\.articles/)[0];
    expect(ins.text).toContain("'planned'");
    expect(ins.values).toContain(OWNER);
  });

  it("requires a topic", async () => {
    const { call } = await boot();
    const r = await call("POST", `/api/v1/sites/${SITE}/articles`, { body: {} });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("invalid_request");
  });

  it("shows an article with its verdict mapped to verified and held claims", async () => {
    const { call, db } = await boot();
    db.on(/from public\.articles where id = \? and owner_id = \?/, [{ id: ART, title: "T", status: "published", published_url: "https://example.com/t", body_md: "Plans cost $49 a month, says [Acme](https://acme.test/pricing). It is the best choice for everyone." }]);
    db.on(/from public\.quality_verdicts/, [{ score: 70, pass: false, summary: "1 issue", judge: "rules-v1", checks: [{ id: "unsourced_claims", label: "x", pass: false, method: "rules", issues: [{ quote: "It is the best choice for everyone.", problem: "No source", fix: "Remove", severity: "block" }] }] }]);
    const r = await call("GET", `/api/v1/articles/${ART}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: ART, title: "T", status: "published", url: "https://example.com/t" });
    expect(r.json.verdict).toMatchObject({ pass: false, score: 70 });
    const statuses = r.json.verdict.checks.map((c: any) => c.status);
    expect(new Set(statuses)).toEqual(new Set(["verified", "held"]));
    expect(r.json.verdict.checks.find((c: any) => c.status === "verified").source).toBe("https://acme.test/pricing");
  });
});

describe("device flow", () => {
  it("creates a code pair and stores only the hash", async () => {
    const { call, db } = await boot({ env: { PAPERBOY_BASE_URL: "https://pb.example.com/" } });
    const r = await call("POST", "/api/v1/device/code", { key: null, body: { client: "paperboy-cli" } });
    expect(r.status).toBe(200);
    expect(r.json.user_code).toMatch(USER_CODE_RE);
    expect(r.json).toMatchObject({
      verification_uri: "https://pb.example.com/device",
      verification_uri_complete: `https://pb.example.com/device?user_code=${r.json.user_code}`,
      interval: 5,
      expires_in: 600,
    });
    const ins = db.find(/insert into public\.device_codes/)[0];
    expect(ins.values[0]).toBe(sha256Hex(r.json.device_code));
    expect(ins.values[1]).toBe(r.json.user_code);
    expect(JSON.stringify(db.calls)).not.toContain(r.json.device_code);
  });

  it("reports pending, slow_down, denied and expired", async () => {
    let t = 10_000_000;
    const { call, db } = await boot({ now: () => t });
    const code = "x".repeat(43);
    const row = (status: string, extra: Record<string, unknown> = {}) => db.on(/from public\.device_codes where device_hash/, [{ id: "d1", owner_id: null, status, expired: false, ...extra }]);
    row("pending");
    const pending = await call("POST", "/api/v1/device/token", { key: null, body: { device_code: code } });
    expect(pending.status).toBe(400);
    expect(pending.json.error.code).toBe("authorization_pending");
    const fast = await call("POST", "/api/v1/device/token", { key: null, body: { device_code: code } });
    expect(fast.json.error.code).toBe("slow_down");
    t += 5000;
    row("denied");
    expect((await call("POST", "/api/v1/device/token", { key: null, body: { device_code: code } })).json.error.code).toBe("access_denied");
    t += 5000;
    row("pending", { expired: true });
    expect((await call("POST", "/api/v1/device/token", { key: null, body: { device_code: code } })).json.error.code).toBe("expired_token");
  });

  it("exchanges an approved code for an API key exactly once", async () => {
    const { call, db } = await boot();
    db.on(/from public\.device_codes where device_hash/, [{ id: "d1", owner_id: OWNER, status: "approved", expired: false }]);
    db.on(/update public\.device_codes set status = 'used'/, [{ owner_id: OWNER }]);
    db.on(/select email from public\.profiles/, [{ email: "op@example.com" }]);
    const r = await call("POST", "/api/v1/device/token", { key: null, body: { device_code: "y".repeat(43) } });
    expect(r.status).toBe(200);
    expect(r.json.api_key).toMatch(/^pb_live_[0-9A-Za-z]{43}$/);
    const ins = db.find(/insert into public\.api_keys/)[0];
    expect(ins.values).toContain(sha256Hex(r.json.api_key));
    expect(ins.values).toContain(OWNER);
    expect(JSON.stringify(db.calls)).not.toContain(r.json.api_key);
  });

  const env = { PAPERBOY_ADMIN_EMAIL: "op@example.com", PAPERBOY_ADMIN_PASSWORD: "correct horse battery" };
  it("shows the approval form with the code filled in and escapes it", async () => {
    const { call } = await boot({ env });
    const r = await call("GET", "/device?user_code=%22%3E%3Cscript%3E", { key: null });
    expect(r.status).toBe(200);
    expect(r.text).toContain("<form");
    expect(r.text).not.toContain("<script>");
  });

  it("approves with the admin password, rejects a wrong one, and rate limits failures", async () => {
    const { base, db } = await boot({ env });
    db.on(/select id from public\.profiles where lower\(email\)/, (v) => (v[0] === env.PAPERBOY_ADMIN_EMAIL ? [{ id: OWNER }] : []));
    db.on(/update public\.device_codes set status = \?/, [{ id: "d1" }]);
    const post = (fields: Record<string, string>) =>
      fetch(`${base}/device`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });

    const wrong = await post({ user_code: "CDFG-HJKM", password: "nope", action: "approve" });
    expect(wrong.status).toBe(401);
    expect(db.find(/update public\.device_codes/)).toHaveLength(0);

    const ok = await post({ user_code: "cdfg hjkm", password: env.PAPERBOY_ADMIN_PASSWORD, action: "approve" });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Approved");
    const upd = db.find(/update public\.device_codes/)[0];
    expect(upd.values).toEqual(["approved", OWNER, "CDFG-HJKM"]);

    for (let i = 0; i < 8; i++) await post({ user_code: "CDFG-HJKM", password: "nope", action: "approve" });
    const blocked = await post({ user_code: "CDFG-HJKM", password: env.PAPERBOY_ADMIN_PASSWORD, action: "approve" });
    expect(blocked.status).toBe(429);
  });

  it("refuses to approve when no admin password is configured", async () => {
    const { base } = await boot({ env: {} });
    const res = await fetch(`${base}/device`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ user_code: "CDFG-HJKM", password: "", action: "approve" }) });
    expect(res.status).toBe(503);
  });
});

describe("fact check and verify", () => {
  it("fact-checks markdown by fetching its cited sources", async () => {
    const fetched: string[] = [];
    const { checkArticle, RuleJudge } = await import("@/lib/quality");
    const { call } = await boot({
      engine: {
        fetchPage: async (u: string) => {
          fetched.push(u);
          if (u.includes("down")) throw new Error("The site could not be reached.");
          return { finalUrl: u, title: "Acme pricing", text: "Acme plans cost $49 a month for teams and include support.", html: "" };
        },
        verify: (input) => checkArticle(input, new RuleJudge()),
      },
    });
    const md = "# Pricing\n\nAcme plans cost $49 a month for teams, according to [Acme](https://acme.test/pricing). Another vendor charges 80% more, per [Gone](https://down.test/x).";
    const r = await call("POST", "/api/v1/fact-check", { body: { markdown: md } });
    expect(r.status).toBe(200);
    expect(fetched.sort()).toEqual(["https://acme.test/pricing", "https://down.test/x"]);
    expect(r.json.claims_total).toBeGreaterThanOrEqual(2);
    expect(r.json.checks.find((c: any) => c.source === "https://acme.test/pricing").status).toBe("verified");
    const dead = r.json.checks.find((c: any) => c.source === "https://down.test/x");
    expect(dead.status).toBe("unsupported");
    expect(dead.note).toContain("could not be opened");
    expect(r.json.pass).toBe(false);
    expect(r.json.claims_verified).toBeLessThan(r.json.claims_total);
  });

  it("requires url or markdown", async () => {
    const { call } = await boot();
    const r = await call("POST", "/api/v1/fact-check", { body: {} });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("invalid_request");
  });

  it("verify returns {verdict} for a QualityInput", async () => {
    const verify = vi.fn(async () => ({ pass: true, score: 100, summary: "ok", judge: "rules-v1", checks: [] }));
    const { call } = await boot({ engine: { verify } });
    const input = { article: { title: "T", bodyMarkdown: "Hello." }, sources: [{ url: "https://a.test", text: "Hello." }] };
    const r = await call("POST", "/api/v1/verify", { body: input });
    expect(r.status).toBe(200);
    expect(r.json.verdict.pass).toBe(true);
    expect(verify).toHaveBeenCalledWith(input, { ownerId: OWNER, local: true });
    expect((await call("POST", "/api/v1/verify", { body: { article: {} } })).status).toBe(400);
  });
});

describe("performance", () => {
  it("aggregates daily totals", async () => {
    const { call, db } = await boot();
    db.on(/from public\.sites where id = \? and owner_id = \?/, [{ id: SITE, owner_id: OWNER }]);
    db.on(/from public\.gsc_daily_totals/, [
      { date: "2026-10-01", clicks: 10, impressions: 100, position: 5 },
      { date: "2026-10-02", clicks: 20, impressions: 300, position: 9 },
    ]);
    const r = await call("GET", `/api/v1/sites/${SITE}/performance?days=7`);
    expect(r.status).toBe(200);
    expect(r.json.days).toBe(7);
    expect(r.json.totals).toEqual({ clicks: 30, impressions: 400, position: 8, ctr: 0.075 });
    expect(r.json.daily).toEqual([
      { date: "2026-10-01", clicks: 10, impressions: 100 },
      { date: "2026-10-02", clicks: 20, impressions: 300 },
    ]);
  });
});
