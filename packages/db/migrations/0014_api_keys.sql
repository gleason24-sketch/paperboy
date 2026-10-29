-- API keys for the CLI, the MCP server and the REST API. Only a hash is stored; the key is shown once.
create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null default 'default',
  prefix text not null,
  key_hash text not null unique,
  scopes text[] not null default '{read,write}',
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists api_keys_owner on public.api_keys (owner_id) where revoked_at is null;

create table if not exists public.api_usage (
  id bigint generated always as identity primary key,
  api_key_id uuid references public.api_keys (id) on delete cascade,
  owner_id uuid not null,
  method text not null,
  path text not null,
  status integer not null,
  ms integer,
  created_at timestamptz not null default now()
);
create index if not exists api_usage_key_day on public.api_usage (api_key_id, created_at desc);

-- Non-article async jobs (fact checks, reports, topic runs).
create table if not exists public.api_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  site_id uuid references public.sites (id) on delete cascade,
  kind text not null check (kind in ('fact_check', 'report', 'topics')),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  input jsonb not null default '{}',
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

-- CLI login (OAuth 2.0 device flow, RFC 8628 style). The device code is stored hashed; the user code is typed in a browser.
create table if not exists public.device_codes (
  id uuid primary key default gen_random_uuid(),
  device_hash text not null unique,
  user_code text not null unique,
  owner_id uuid references public.profiles (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'used')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.api_keys enable row level security;
alter table public.api_usage enable row level security;
alter table public.api_jobs enable row level security;
alter table public.device_codes enable row level security;
create policy api_keys_own_select on public.api_keys for select to authenticated using (owner_id = (select auth.uid()));
create policy api_jobs_own_select on public.api_jobs for select to authenticated using (owner_id = (select auth.uid()));
revoke all on public.api_keys, public.api_usage, public.api_jobs, public.device_codes from anon;
grant select, insert, update, delete on public.api_keys, public.api_usage, public.api_jobs, public.device_codes to paperboy_server;
grant usage, select on all sequences in schema public to paperboy_server;
