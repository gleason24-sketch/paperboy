// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from "vitest";
import { msUntilUtc, startWorker } from "@/server/worker";
import { seed } from "@/server/seed";
import { fakeSql } from "./fake-sql";

describe("msUntilUtc", () => {
  const at = (iso: string) => Date.parse(iso);
  it("finds the next time of day, today or tomorrow", () => {
    expect(msUntilUtc(at("2026-10-29T05:00:00Z"), 6, 15)).toBe(75 * 60_000);
    expect(msUntilUtc(at("2026-10-29T06:15:00Z"), 6, 15)).toBe(24 * 3600_000);
    expect(msUntilUtc(at("2026-10-29T07:00:00Z"), 6, 15)).toBe((23 * 60 + 15) * 60_000);
  });
  it("finds the next Monday", () => {
    // 2026-10-29 is a Thursday; the next Monday is 2026-11-02.
    expect(msUntilUtc(at("2026-10-29T00:00:00Z"), 13, 0, 1)).toBe(at("2026-11-02T13:00:00Z") - at("2026-10-29T00:00:00Z"));
  });
});

describe("worker", () => {
  it("runs planned articles two at a time and stops cleanly", async () => {
    const db = fakeSql([{ re: /from articles where status = 'planned'/, rows: [{ id: "a1" }, { id: "a2" }, { id: "a3" }] }]);
    const release: Array<() => void> = [];
    const runArticle = vi.fn((id: string) => new Promise<void>((r) => release.push(r)));
    const logs: string[] = [];
    const w = startWorker({ sql: () => db.sql, runArticle, jobs: false, pollMs: 3_600_000, log: (l) => logs.push(l), graceMs: 2000 });
    await w.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(w.running().sort()).toEqual(["a1", "a2"]);
    expect(runArticle).toHaveBeenCalledTimes(2);
    expect(db.calls[0].text).toContain("locked_until is null or locked_until < now()");
    const stopped = w.stop();
    release.forEach((r) => r());
    await stopped;
    expect(w.running()).toEqual([]);
    expect(logs.some((l) => l.includes("stopped"))).toBe(true);
  });

  it("keeps going when an article crashes", async () => {
    const db = fakeSql([{ re: /from articles where status = 'planned'/, rows: [{ id: "a1" }] }]);
    const logs: string[] = [];
    const w = startWorker({ sql: () => db.sql, runArticle: async () => { throw new Error("boom"); }, jobs: false, pollMs: 3_600_000, log: (l) => logs.push(l) });
    await w.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(logs.join("\n")).toContain("article a1 crashed: boom");
    await w.stop();
  });
});

describe("seed", () => {
  it("creates the user, makes it admin and is idempotent", async () => {
    const db = fakeSql();
    const r1 = await seed(db.sql, { email: "Op@Example.com", password: "long enough pw", log: () => {} });
    expect(r1.created).toBe(true);
    const ins = db.find(/insert into auth\.users/)[0];
    expect(ins.text).toContain("extensions.crypt(?, extensions.gen_salt('bf'))");
    expect(ins.values).toContain("op@example.com");
    expect(ins.values).toContain("long enough pw");
    expect(db.find(/update public\.profiles set is_admin = true/)).toHaveLength(1);

    db.on(/select id from auth\.users/, [{ id: r1.userId }]);
    const before = db.find(/insert into auth\.users/).length;
    const r2 = await seed(db.sql, { email: "op@example.com", password: "long enough pw", log: () => {} });
    expect(r2).toMatchObject({ created: false, userId: r1.userId });
    expect(db.find(/insert into auth\.users/)).toHaveLength(before);
  });

  it("rejects weak input", async () => {
    await expect(seed(fakeSql().sql, { email: "nope", password: "long enough pw" })).rejects.toThrow(/email/);
    await expect(seed(fakeSql().sql, { email: "a@b.co", password: "short" })).rejects.toThrow(/8 characters/);
  });
});
