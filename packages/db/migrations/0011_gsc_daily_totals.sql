-- Per-day Search Console totals (date dimension only, so anonymized queries are counted and the totals match Search Console).
-- The homepage "real numbers" block reads these rows and the fetch time below; a stale fetch hides the numbers.
create table if not exists public.gsc_daily_totals (
  site_id uuid not null references public.sites(id) on delete cascade,
  date date not null,
  clicks integer not null default 0,
  impressions integer not null default 0,
  position double precision not null default 0,
  fetched_at timestamptz not null default now(),
  primary key (site_id, date)
);
alter table public.gsc_daily_totals enable row level security; -- no policies: server only
revoke all on public.gsc_daily_totals from anon, authenticated;
grant select, insert, update on public.gsc_daily_totals to paperboy_server;

-- When the last Search Console pull SUCCEEDED, and why the latest one failed (null when it worked).
alter table public.sites add column if not exists gsc_totals_fetched_at timestamptz;
alter table public.sites add column if not exists gsc_error text;
alter table public.sites add column if not exists gsc_error_at timestamptz;
