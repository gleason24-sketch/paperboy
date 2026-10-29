-- Rewrites per article and per-step timing used by the pipeline.
alter table public.articles add column if not exists rewrites int not null default 0;
alter table public.articles add column if not exists step_times jsonb not null default '{}'::jsonb;
alter table public.sites add column if not exists trial_started_at timestamptz;
alter table public.sites add column if not exists trial_ends_at timestamptz;
