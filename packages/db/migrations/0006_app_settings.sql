-- Server-only settings the app writes for itself (for example the Stripe webhook signing secret created by the admin
-- "Set up Stripe" button). RLS on and no policies: never readable through the API.
create table if not exists public.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;
grant select, insert, update, delete on public.app_settings to paperboy_server;
