-- SERP-strength gate: before a topic is written, the engine looks at the top 10 for its target query and skips the topic when
-- more than half of the ranking domains are strong. Every decision is logged here so the dashboard, the rank loop and the
-- admin can show "skipped: SERP too strong (7/10 strong: g2.com, ...)".
--  tranco_ranks     the top 100,000 of the Tranco list (https://tranco-list.eu), refreshed weekly by the engine; a free authority proxy
--  serp_gate_log    one row per decision (pass, skip, blocked, exhausted, override, unchecked)
-- Additive only. Both tables are read and written only by the server, like topic_ideas.

create table if not exists public.tranco_ranks (
  domain text primary key,
  rank integer not null,
  list_id text not null
);
create index if not exists tranco_ranks_rank on public.tranco_ranks (rank);

create table if not exists public.serp_gate_log (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,
  article_id uuid references public.articles (id) on delete set null,
  topic text,
  target_query text not null,
  decision text not null check (decision in ('pass', 'skip', 'unchecked', 'blocked', 'exhausted', 'override')),
  strong_count integer,
  total integer,
  strong_domains jsonb not null default '[]'::jsonb,
  domains jsonb not null default '[]'::jsonb,
  reason text not null,
  source text,
  created_at timestamptz not null default now()
);
create index if not exists serp_gate_log_site on public.serp_gate_log (site_id, created_at desc);
create index if not exists serp_gate_log_decision on public.serp_gate_log (site_id, decision, created_at desc);

alter table public.tranco_ranks enable row level security; -- no policies: server only
alter table public.serp_gate_log enable row level security;
revoke all on public.tranco_ranks, public.serp_gate_log from anon, authenticated;
grant select, insert, update, delete on public.tranco_ranks, public.serp_gate_log to paperboy_server;
