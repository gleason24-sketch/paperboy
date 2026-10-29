// SPDX-License-Identifier: AGPL-3.0-only
// Applies the migrations in order, once each, and sets the password of the app's database role.
//   DATABASE_URL            admin connection (the postgres superuser)
//   PAPERBOY_DB_PASSWORD    password for the paperboy_server role the app connects as
//   PAPERBOY_DB_SHIM=1      also apply shim.sql first (plain Postgres has no Supabase "auth" schema; skip it on Supabase)
import postgres from "postgres";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(2);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  await sql`create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  if (process.env.PAPERBOY_DB_SHIM === "1") await sql.file(join(here, "shim.sql"));
  const done = new Set((await sql`select name from public.schema_migrations`).map((r) => r.name));
  const files = readdirSync(join(here, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    await sql.begin(async (tx) => {
      await tx.file(join(here, "migrations", f));
      await tx`insert into public.schema_migrations (name) values (${f})`;
    });
    console.log(`applied ${f}`);
  }
  const pw = process.env.PAPERBOY_DB_PASSWORD;
  if (pw) await sql.unsafe(`alter role paperboy_server with login password '${pw.replace(/'/g, "''")}'`);
  console.log("migrations up to date");
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await sql.end();
}
