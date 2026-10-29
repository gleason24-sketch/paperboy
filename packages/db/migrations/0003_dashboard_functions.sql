-- Read-only aggregates for the dashboard. SECURITY INVOKER: they run as the signed-in user, so row-level security
-- on gsc_rows and articles still decides which rows are counted.

create or replace function public.site_daily(p_site uuid, p_days int default 56)
returns table (date date, clicks int, impressions int, "position" real)
language sql stable security invoker set search_path = '' as $$
  select g.date, sum(g.clicks)::int, sum(g.impressions)::int,
    (case when sum(g.impressions) > 0 then sum(g.position * g.impressions) / sum(g.impressions) else 0 end)::real
  from public.gsc_rows g
  where g.site_id = p_site and g.date >= current_date - p_days
  group by g.date order by g.date
$$;

create or replace function public.article_performance(p_site uuid, p_days int default 28)
returns table (article_id uuid, clicks int, impressions int, "position" real, queries int)
language sql stable security invoker set search_path = '' as $$
  select a.id, coalesce(sum(g.clicks), 0)::int, coalesce(sum(g.impressions), 0)::int,
    (case when sum(g.impressions) > 0 then sum(g.position * g.impressions) / sum(g.impressions) else 0 end)::real,
    count(distinct g.query)::int
  from public.articles a
  left join public.gsc_rows g on g.site_id = a.site_id and g.page = a.published_url and g.date >= current_date - p_days
  where a.site_id = p_site and a.published_url is not null
  group by a.id
$$;

create or replace function public.article_queries(p_article uuid, p_days int default 28)
returns table (query text, clicks int, impressions int, "position" real)
language sql stable security invoker set search_path = '' as $$
  select g.query, sum(g.clicks)::int, sum(g.impressions)::int,
    (case when sum(g.impressions) > 0 then sum(g.position * g.impressions) / sum(g.impressions) else 0 end)::real
  from public.articles a join public.gsc_rows g on g.site_id = a.site_id and g.page = a.published_url
  where a.id = p_article and g.date >= current_date - p_days
  group by g.query order by 3 desc limit 50
$$;

revoke all on function public.site_daily(uuid, int), public.article_performance(uuid, int), public.article_queries(uuid, int) from public, anon;
grant execute on function public.site_daily(uuid, int), public.article_performance(uuid, int), public.article_queries(uuid, int) to authenticated;
