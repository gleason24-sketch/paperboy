-- Search results are saved before pages are opened, so a retry after a crash reuses them instead of searching again.
alter table public.articles add column if not exists found_sources jsonb not null default '[]'::jsonb;
