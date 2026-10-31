// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeSql } from "./fake-sql";

const db = fakeSql([{ re: /from sites where not paused/, rows: [] }]);
vi.mock("@/lib/db", () => ({ sql: () => db.sql }));

afterEach(() => {
  delete process.env.PAPERBOY_ARTICLES_PER_WEEK;
  db.calls.length = 0;
});

describe("scheduleDue", () => {
  it("does not look for sites to write for when PAPERBOY_ARTICLES_PER_WEEK is 0, but still restarts stuck articles", async () => {
    process.env.PAPERBOY_ARTICLES_PER_WEEK = "0";
    const { scheduleDue } = await import("@/lib/jobs");
    await scheduleDue();
    expect(db.find(/from sites where not paused/)).toHaveLength(0);
    expect(db.find(/status = 'planned' and attempts >= 4/)).toHaveLength(1);
  });

  it("looks at every unpaused site otherwise", async () => {
    process.env.PAPERBOY_ARTICLES_PER_WEEK = "3";
    const { scheduleDue } = await import("@/lib/jobs");
    await scheduleDue();
    expect(db.find(/from sites where not paused/)).toHaveLength(1);
  });
});
