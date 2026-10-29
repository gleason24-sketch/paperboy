-- Paperboy core schema. Every customer table carries owner_id and has row-level security on.
-- Customers read their own rows through the API. Writes that touch billing, publishing secrets or the article
-- pipeline go through the server, which connects as the paperboy_server role (see 20261003000002_server_role.sql).

create extension if not exists pgcrypto with schema extensions;

-- ---------- profiles ----------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  stripe_customer_id text unique,
  is_admin boolean not null default false,
  weekly_report boolean not null default true,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email) values (new.id, coalesce(new.email, '')) on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- sites ----------
create table public.sites (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  url text not null,
  domain text not null,
  name text not null default '',
  slug text not null unique,
  scan jsonb not null default '{}'::jsonb,
  voice jsonb not null default '{}'::jsonb,
  banned_claims text[] not null default '{}',
  words_to_avoid text[] not null default '{}',
  cta_text text not null default '',
  cta_url text not null default '',
  publish_method text not null default 'hosted' check (publish_method in ('hosted', 'prompt', 'wordpress', 'ghost', 'webhook')),
  publish_config jsonb not null default '{}'::jsonb,
  approval_mode text not null default 'autopilot' check (approval_mode in ('autopilot', 'approve')),
  plan text not null default 'free' check (plan in ('free', 'starter', 'growth', 'pro')),
  billing_interval text check (billing_interval in ('month', 'year')),
  subscription_status text,
  stripe_subscription_id text unique,
  cancel_at_period_end boolean not null default false,
  current_period_end timestamptz,
  revenue_cents_monthly integer not null default 0,
  site_key text not null unique default encode(extensions.gen_random_bytes(18), 'hex'),
  indexnow_key text not null default encode(extensions.gen_random_bytes(16), 'hex'),
  blog_host text unique,
  blog_host_status text not null default 'not_set' check (blog_host_status in ('not_set', 'waiting_dns', 'live', 'error')),
  gsc_property text,
  gsc_connected_at timestamptz,
  gsc_last_sync timestamptz,
  gsc_skipped boolean not null default false,
  paused boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sites_owner on public.sites (owner_id);

-- Secrets for publishing and Google. No API access at all: only the server role reads these.
create table public.site_secrets (
  site_id uuid primary key references public.sites (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  wp_app_password text,
  ghost_admin_key text,
  webhook_secret text,
  gsc_refresh_token text,
  updated_at timestamptz not null default now()
);

-- ---------- articles ----------
create table public.articles (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'planned' check (status in
    ('planned', 'picking', 'researching', 'writing', 'checking', 'fixing', 'publishing', 'published', 'needs_review', 'failed')),
  review_reason text check (review_reason in ('quality', 'approval', 'cost_cap', 'publish_error', 'error')),
  review_note text,
  step_note text,
  kind text not null default 'new' check (kind in ('new', 'refresh')),
  refresh_of uuid references public.articles (id) on delete set null,
  is_free boolean not null default false,
  topic text,
  target_query text,
  angle text,
  intent text,
  reason text,
  title text,
  slug text,
  meta_title text,
  meta_description text,
  excerpt text,
  body_md text,
  body_html text,
  faq jsonb not null default '[]'::jsonb,
  schema_ld jsonb not null default '[]'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  internal_links jsonb not null default '[]'::jsonb,
  cta_text text,
  cta_url text,
  quality_score integer,
  quality_pass boolean,
  cost_usd numeric(10, 4) not null default 0,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  searches integer not null default 0,
  published_url text,
  external_id text,
  published_at timestamptz,
  updated_content_at timestamptz,
  approval_token text not null default encode(extensions.gen_random_bytes(18), 'hex'),
  locked_until timestamptz,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index articles_site on public.articles (site_id, created_at desc);
create index articles_owner on public.articles (owner_id);
create index articles_status on public.articles (status);
create unique index articles_site_slug on public.articles (site_id, slug) where slug is not null and kind = 'new';

create table public.article_sources (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  url text not null,
  title text,
  text text not null default '',
  selling boolean not null default false,
  selling_note text,
  facts jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null default now()
);
create index article_sources_article on public.article_sources (article_id);

create table public.quality_verdicts (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  round integer not null,
  judge text not null,
  score integer not null,
  pass boolean not null,
  summary text,
  checks jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index quality_verdicts_article on public.quality_verdicts (article_id, round);

-- ---------- cost log ----------
create table public.ai_usage (
  id bigserial primary key,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  site_id uuid references public.sites (id) on delete cascade,
  article_id uuid references public.articles (id) on delete set null,
  purpose text not null,
  model text not null,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  searches integer not null default 0,
  cost_usd numeric(10, 5) not null default 0,
  created_at timestamptz not null default now()
);
create index ai_usage_owner on public.ai_usage (owner_id, created_at desc);
create index ai_usage_site on public.ai_usage (site_id, created_at desc);

-- ---------- Search Console ----------
create table public.gsc_rows (
  site_id uuid not null references public.sites (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  date date not null,
  query text not null,
  page text not null,
  clicks integer not null default 0,
  impressions integer not null default 0,
  position real not null default 0,
  primary key (site_id, date, query, page)
);
create index gsc_rows_page on public.gsc_rows (site_id, page);

-- The reasoning shown on the dashboard ("This article is on page two for 14 searches, so ...").
create table public.insights (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  article_id uuid references public.articles (id) on delete set null,
  kind text not null check (kind in ('next_topic', 'refresh', 'note', 'performance')),
  text text not null,
  created_at timestamptz not null default now()
);
create index insights_site on public.insights (site_id, created_at desc);

-- ---------- abuse limits and waitlists (server only) ----------
create table public.free_claims (
  domain text primary key,
  user_id uuid not null unique references public.profiles (id) on delete cascade,
  site_id uuid references public.sites (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.scans (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  domain text not null,
  result jsonb not null,
  ip_hash text,
  created_at timestamptz not null default now()
);
create index scans_ip on public.scans (ip_hash, created_at desc);

create table public.notify_requests (
  id bigserial primary key,
  email text not null,
  feature text not null,
  user_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (email, feature)
);

create table public.stripe_events (
  id text primary key,
  type text not null,
  created_at timestamptz not null default now()
);

-- ---------- updated_at ----------
create or replace function public.touch_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;
create trigger sites_touch before update on public.sites for each row execute function public.touch_updated_at();
create trigger articles_touch before update on public.articles for each row execute function public.touch_updated_at();

-- ---------- row-level security ----------
alter table public.profiles enable row level security;
alter table public.sites enable row level security;
alter table public.site_secrets enable row level security;
alter table public.articles enable row level security;
alter table public.article_sources enable row level security;
alter table public.quality_verdicts enable row level security;
alter table public.ai_usage enable row level security;
alter table public.gsc_rows enable row level security;
alter table public.insights enable row level security;
alter table public.free_claims enable row level security;
alter table public.scans enable row level security;
alter table public.notify_requests enable row level security;
alter table public.stripe_events enable row level security;

-- Start from nothing, then grant exactly what the browser may do.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on public.profiles to authenticated;
grant update (full_name, weekly_report) on public.profiles to authenticated;
create policy profiles_own_select on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy profiles_own_update on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

grant select on public.sites to authenticated;
grant update (name, scan, voice, banned_claims, words_to_avoid, cta_text, cta_url, approval_mode, paused) on public.sites to authenticated;
create policy sites_own_select on public.sites for select to authenticated using (owner_id = (select auth.uid()));
create policy sites_own_update on public.sites for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

grant select on public.articles, public.article_sources, public.quality_verdicts, public.ai_usage, public.gsc_rows, public.insights to authenticated;
create policy articles_own on public.articles for select to authenticated using (owner_id = (select auth.uid()));
create policy article_sources_own on public.article_sources for select to authenticated using (owner_id = (select auth.uid()));
create policy quality_verdicts_own on public.quality_verdicts for select to authenticated using (owner_id = (select auth.uid()));
create policy ai_usage_own on public.ai_usage for select to authenticated using (owner_id = (select auth.uid()));
create policy gsc_rows_own on public.gsc_rows for select to authenticated using (owner_id = (select auth.uid()));
create policy insights_own on public.insights for select to authenticated using (owner_id = (select auth.uid()));

-- site_secrets, free_claims, scans, notify_requests, stripe_events: RLS on and no policies, so the API can never read them.
