-- The topic queue per site: ideas the customer adds (written first), topics Paperboy suggests ahead of time (shown
-- after the free article so people see what they would get), and topics the customer never wants.
create table if not exists public.topic_ideas (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('idea', 'suggested', 'block')),
  text text not null,
  target_query text,
  angle text,
  intent text,
  reason text,
  status text not null default 'open' check (status in ('open', 'used', 'skipped')),
  article_id uuid references public.articles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists topic_ideas_site_open on public.topic_ideas (site_id, status, kind);
alter table public.topic_ideas enable row level security; -- no policies: read and written only by the server
revoke all on public.topic_ideas from anon, authenticated;
grant select, insert, update, delete on public.topic_ideas to paperboy_server;
