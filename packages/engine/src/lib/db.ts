// SPDX-License-Identifier: AGPL-3.0-only
// Server-side database access. Connects as the paperboy_server role (directly in Docker, or through a pooler on Supabase).
// Used by the article pipeline, the API server and the scheduled jobs. Never imported into browser code.
import postgres from "postgres";

type Sql = ReturnType<typeof postgres>;
let client: Sql | null = null;

export function sql(): Sql {
  if (client) return client;
  const url = process.env.SERVER_DATABASE_URL;
  if (!url) throw new Error("SERVER_DATABASE_URL is not set. See docs/self-host.md.");
  // TLS is on unless the database is on this machine or the compose network (host "db"), or PAPERBOY_DB_SSL=disable.
  const plain = process.env.PAPERBOY_DB_SSL === "disable" || /@(localhost|127\.0\.0\.1|db)[:/]/.test(url);
  client = postgres(url, {
    prepare: false, // required by the transaction-mode pooler
    max: 4,
    idle_timeout: 20,
    connect_timeout: 15,
    ssl: plain ? false : "require",
    types: { numeric: { to: 1700, from: [1700], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) } } as never,
  });
  return client;
}

export type Row = Record<string, any>;
