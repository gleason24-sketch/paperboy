// SPDX-License-Identifier: AGPL-3.0-only
// Applies the shim and every migration, in order, to an in-memory Postgres (PGlite). Catches broken SQL and numbering gaps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = readdirSync(join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort();

test("migration numbers are unique and contiguous", () => {
  const nums = files.map((f) => Number(f.slice(0, 4)));
  assert.deepEqual(nums, nums.map((_, i) => i + 1));
});

test("shim and all migrations apply to a fresh database", async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(readFileSync(join(root, "shim.sql"), "utf8"));
  for (const f of files) await db.exec(readFileSync(join(root, "migrations", f), "utf8"));
  const { rows } = await db.query("select table_name from information_schema.tables where table_schema = 'public'");
  const names = new Set(rows.map((r) => r.table_name));
  for (const t of ["profiles", "sites", "articles", "article_sources", "quality_verdicts", "gsc_daily_totals", "topic_ideas", "serp_gate_log", "api_keys", "device_codes"])
    assert.ok(names.has(t), `missing table ${t}`);
  const col = await db.query("select 1 from information_schema.columns where table_name = 'gsc_daily_totals' and column_name = 'source'");
  assert.equal(col.rows.length, 1);
});
