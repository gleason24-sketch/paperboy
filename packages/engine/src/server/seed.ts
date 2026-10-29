// SPDX-License-Identifier: AGPL-3.0-only
// Creates the first operator account from the environment. Safe to run on every start: it only fills in what is missing.
//   DATABASE_URL                  admin connection (the postgres superuser). The paperboy_server role cannot write auth.users.
//   PAPERBOY_ADMIN_EMAIL          the operator's email
//   PAPERBOY_ADMIN_PASSWORD       the operator's password (at least 8 characters); also the password on the /device approval page
//   PAPERBOY_SEED_API_KEY_FILE    optional: mint an API key and write it to this path (mode 0600). Only the key prefix is printed.
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { generateApiKey, keyPrefix, parseBearer, sha256Hex } from "./keys";

type Row = Record<string, any>;
type Sql = (strings: TemplateStringsArray, ...values: any[]) => PromiseLike<Row[]>;

export type SeedOptions = { email: string; password: string; keyFile?: string; log?: (line: string) => void };
export type SeedResult = { userId: string; created: boolean; keyPrefix?: string };

export async function seed(db: Sql, opts: SeedOptions): Promise<SeedResult> {
  const log = opts.log ?? ((l: string) => console.log(`[seed] ${l}`));
  const email = opts.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("PAPERBOY_ADMIN_EMAIL is not a valid email address.");
  if (opts.password.length < 8) throw new Error("PAPERBOY_ADMIN_PASSWORD must be at least 8 characters.");

  let [user] = await db`select id from auth.users where lower(email) = ${email}`;
  let created = false;
  if (!user) {
    const id = randomUUID();
    await db`insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current, phone_change, phone_change_token, reauthentication_token)
      values ('00000000-0000-0000-0000-000000000000', ${id}, 'authenticated', 'authenticated', ${email}, extensions.crypt(${opts.password}, extensions.gen_salt('bf')), now(),
        '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(), '', '', '', '', '', '', '', '')`;
    // Real Supabase wants an identity row for email sign-in; the plain Postgres shim has the table too. Skip quietly if it does not.
    await Promise.resolve(
      db`insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
        values (${randomUUID()}, ${id}, ${id}, jsonb_build_object('sub', ${id}::text, 'email', ${email}::text), 'email', now(), now(), now())`,
    ).catch((e) => log(`identity row skipped: ${e instanceof Error ? e.message : String(e)}`));
    user = { id };
    created = true;
    log(`created account ${email}`);
  } else {
    log(`account ${email} already exists`);
  }
  // The handle_new_user trigger creates the profile; make sure it exists even if the trigger was not installed.
  await db`insert into public.profiles (id, email) values (${user.id}, ${email}) on conflict (id) do nothing`;
  await db`update public.profiles set is_admin = true where id = ${user.id} and not is_admin`;

  let prefix: string | undefined;
  if (opts.keyFile) prefix = await seedKey(db, user.id, opts.keyFile, log);
  return { userId: user.id, created, keyPrefix: prefix };
}

/** Writes an API key to `file` (mode 0600). If the file already holds a live key for this owner, it is kept. */
async function seedKey(db: Sql, ownerId: string, file: string, log: (l: string) => void): Promise<string> {
  if (existsSync(file)) {
    const existing = parseBearer(`Bearer ${readFileSync(file, "utf8").trim()}`);
    if (existing) {
      const [row] = await db`select id from public.api_keys where key_hash = ${sha256Hex(existing)} and owner_id = ${ownerId} and revoked_at is null`;
      if (row) {
        log(`API key ${keyPrefix(existing)}... already in ${file}`);
        return keyPrefix(existing);
      }
    }
  }
  const k = generateApiKey();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${k.key}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  await db`insert into public.api_keys (owner_id, name, prefix, key_hash) values (${ownerId}, 'seed', ${k.prefix}, ${k.hash})`;
  log(`API key ${k.prefix}... written to ${file}`);
  return k.prefix;
}

async function main() {
  const url = process.env.DATABASE_URL;
  const email = process.env.PAPERBOY_ADMIN_EMAIL;
  const password = process.env.PAPERBOY_ADMIN_PASSWORD;
  if (!url) throw new Error("DATABASE_URL is not set (the admin connection, used only by this script).");
  if (!email || !password) throw new Error("Set PAPERBOY_ADMIN_EMAIL and PAPERBOY_ADMIN_PASSWORD.");
  const db = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 15 });
  try {
    await seed(db as unknown as Sql, { email, password, keyFile: process.env.PAPERBOY_SEED_API_KEY_FILE || undefined });
  } finally {
    await db.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`[seed] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
