-- Rank loop: the Search Console feedback loop run for every customer site.
--  seo_opportunities   the open fixes found in a site's own Search Console data (ctr_fix, needs_own_page, push_to_1, striking_distance, cluster, slipping)
--  seo_page_snapshots  daily title / meta description of the pages that get impressions, to see when a title changes
--  seo_tests           every title/meta change, scored 28 days later against the 28 days before (win / loss / neutral)
-- All three are read and written only by the server (like topic_ideas); customers see them through the site dashboard.

create table if not exists public.seo_opportunities (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  type text not null check (type in ('ctr_fix', 'needs_own_page', 'push_to_1', 'striking_distance', 'cluster', 'slipping')),
  key text not null,
  page text,
  query text,
  impressions integer not null default 0,
  clicks integer not null default 0,
  position real,
  data jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'queued', 'fixed', 'suggested', 'dismissed', 'stale')),
  action text,
  suggestion jsonb,
  article_id uuid references public.articles (id) on delete set null,
  topic_idea_id uuid references public.topic_ideas (id) on delete set null,
  first_seen date not null default current_date,
  last_seen date not null default current_date,
  resolved_at timestamptz,
  unique (site_id, type, key)
);
create index if not exists seo_opportunities_site on public.seo_opportunities (site_id, status, type);

create table if not exists public.seo_page_snapshots (
  id bigint generated always as identity primary key,
  site_id uuid not null references public.sites (id) on delete cascade,
  page_key text not null,
  page text not null,
  fetched_on date not null default current_date,
  title text,
  meta_description text,
  h1 text,
  unique (site_id, page_key, fetched_on)
);
create index if not exists seo_page_snapshots_page on public.seo_page_snapshots (site_id, page_key, fetched_on desc);

create table if not exists public.seo_tests (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  page_key text not null,
  page text not null,
  changed_on date not null default current_date,
  source text not null default 'detected' check (source in ('paperboy', 'detected')),
  old_title text,
  new_title text,
  old_meta text,
  new_meta text,
  target_query text,
  outcome text not null default 'pending' check (outcome in ('pending', 'win', 'loss', 'neutral')),
  before_stats jsonb,
  after_stats jsonb,
  measured_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists seo_tests_site on public.seo_tests (site_id, changed_on desc);
create index if not exists seo_tests_pending on public.seo_tests (outcome, changed_on);

-- A page URL as one comparable key, however Google or the site writes it (http/https, www, query string, fragment, trailing slash),
-- and just its path. Used to match Search Console pages to articles and to title tests.
create or replace function public.seo_page_key(u text) returns text language sql immutable set search_path = '' as $$
  select regexp_replace(lower(split_part(split_part(coalesce(u, ''), '#', 1), '?', 1)), '^https?://(www\.)?|/+$', '', 'g')
$$;
create or replace function public.seo_page_path(u text) returns text language sql immutable set search_path = '' as $$
  select regexp_replace(public.seo_page_key(u), '^[^/]*', '')
$$;

-- Rank loop topics go ahead of the generic suggestions in the topic queue.
alter table public.topic_ideas add column if not exists priority integer not null default 0;
alter table public.topic_ideas add column if not exists opportunity_type text;

alter table public.seo_opportunities enable row level security; -- no policies: server only
alter table public.seo_page_snapshots enable row level security;
alter table public.seo_tests enable row level security;
revoke all on public.seo_opportunities, public.seo_page_snapshots, public.seo_tests from anon, authenticated;
grant select, insert, update, delete on public.seo_opportunities, public.seo_page_snapshots, public.seo_tests to paperboy_server;
grant usage, select on all sequences in schema public to paperboy_server;
