-- "New" dot on Articles: when the customer last looked at a finished article. Existing finished articles count as seen.
alter table public.articles add column if not exists seen_at timestamptz;
update public.articles set seen_at = now() where seen_at is null and status in ('published', 'needs_review', 'failed');
create index if not exists articles_unseen on public.articles (site_id) where seen_at is null;
-- Email when each article goes live (on by default; switch in Account).
alter table public.profiles add column if not exists notify_published boolean not null default true;
grant update (notify_published) on public.profiles to authenticated;
