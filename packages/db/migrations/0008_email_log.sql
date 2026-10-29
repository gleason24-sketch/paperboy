-- Which lifecycle emails each person has been sent (so each goes once).
create table if not exists public.email_log (
  owner_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,
  sent_at timestamptz not null default now(),
  primary key (owner_id, kind)
);
alter table public.email_log enable row level security;
revoke all on public.email_log from anon, authenticated;
grant select, insert, update, delete on public.email_log to paperboy_server;
