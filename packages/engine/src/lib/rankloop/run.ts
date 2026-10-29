// The rank loop for one customer site, run daily after the Search Console pull (job "rankloop"):
//   1. find the opportunities in the site's own Search Console data and keep them in seo_opportunities
//   2. act: queue articles for needs_own_page / cluster, rewrite title + meta for pages Paperboy publishes, store the suggested
//      fix for pages it cannot edit, and pick refreshes for slipping / push_to_1 / striking_distance articles (scheduleDue)
//   3. measure: snapshot titles daily, log changes, score each change 28 days later, feed the winners back into the prompt
import { z } from "zod";
import { MODELS } from "@/config/models";
import { Budget, structured } from "@/lib/ai/client";
import { blockedReason } from "@/lib/engine/blocklist";
import { sql } from "@/lib/db";
import { fetchPage } from "@/lib/fetchpage";
import { pingIndexNow, publishArticle } from "@/lib/publish";
import type { ArticleRow, SiteRow } from "@/lib/types";
import { noDashesDeep, overlap } from "@/lib/util";
import { computeOpportunities, pathOf, type OppRow, type SeoOpportunities } from "./opps";
import { MEASURE_AFTER_DAYS, scoreTest, type Stats } from "./measure";
import { diffTitleMeta, normUrl, pagesToWatch, recentlyLogged, type Snapshot } from "./snapshots";
import { OPP_TYPES, rankLoopStatus, sortRankLoop, type LoopStats, type OppCounts } from "./status";
import { titleStyles } from "./styles";
import { clampTitle, titleMetaIssues, type TitleMeta } from "./titles";

const db = () => sql();

/** Publishers that send the title tag (meta_title) and meta description to the live page. WordPress sends only the post title. */
export const canEditMeta = (site: Pick<SiteRow, "publish_method">) => ["hosted", "prompt", "ghost", "webhook"].includes(site.publish_method);

/** Just the path of a page URL ("example.com/a/b" -> "/a/b"), so www, http and a custom blog host do not split one page in two. Mirrors seo_page_path() in SQL. */
const pathKey = (url: string) => normUrl(url).replace(/^[^/]*/, "");

// ---------- 1. opportunities ----------

/** Current 28 days per page + query, prior 28 days per page, and the totals, ending at the newest Search Console date. */
export async function loadOppRows(siteId: string): Promise<OppRow[]> {
  const rows = await db()`
    with m as (select max(date) d from gsc_rows where site_id = ${siteId}),
    cur as (
      select g.page, lower(g.query) query, sum(g.clicks)::int clicks, sum(g.impressions)::int impressions,
        case when sum(g.impressions) > 0 then sum(g.position * g.impressions) / sum(g.impressions) end position
      from gsc_rows g, m where g.site_id = ${siteId} and g.date > m.d - 28 group by g.page, lower(g.query)
    ), prior as (
      select g.page, sum(g.clicks)::int clicks, sum(g.impressions)::int impressions,
        case when sum(g.impressions) > 0 then sum(g.position * g.impressions) / sum(g.impressions) end position
      from gsc_rows g, m where g.site_id = ${siteId} and g.date <= m.d - 28 and g.date > m.d - 56 group by g.page
    )
    select 'cur' win, page, query, clicks, impressions, position from cur
    union all select 'prior', page, '', clicks, impressions, position from prior
    union all select 'cur_total', '', '', coalesce(sum(clicks), 0)::int, coalesce(sum(impressions), 0)::int, null from cur
    union all select 'prior_total', '', '', coalesce(sum(clicks), 0)::int, coalesce(sum(impressions), 0)::int, null from prior`;
  return rows.map((r) => ({ win: r.win, page: r.page, query: r.query, clicks: r.clicks, impressions: r.impressions, position: r.position == null ? null : Number(r.position) })) as OppRow[];
}

type Item = { type: (typeof OPP_TYPES)[number]; key: string; page: string | null; query: string | null; impressions: number; clicks: number; position: number | null; data: Record<string, unknown> };

export function flattenOpportunities(o: SeoOpportunities): Item[] {
  const out: Item[] = [];
  const push = (type: Item["type"], key: string, x: Record<string, any>, page: string | null, query: string | null) =>
    out.push({ type, key: key.slice(0, 300), page, query, impressions: Number(x.impressions ?? 0), clicks: Number(x.clicks ?? 0), position: x.position == null ? null : Number(x.position), data: x });
  for (const x of o.ctr_fix) push("ctr_fix", x.page, x, x.page, x.queries[0]?.query ?? null);
  for (const x of o.needs_own_page) push("needs_own_page", x.query, x, x.ranking_page, x.query);
  for (const x of o.push_to_1) push("push_to_1", `${x.page}|${x.query}`, x, x.page, x.query);
  for (const x of o.striking_distance) push("striking_distance", `${x.page}|${x.query}`, x, x.page, x.query);
  for (const x of o.cluster) push("cluster", x.term, x, x.best_pages[0] ?? null, x.queries[0] ?? null);
  for (const x of o.slipping) push("slipping", x.page, x, x.page, null);
  return out;
}

/** Stores today's opportunities. Items that disappeared become stale; fixed or queued ones reopen after 28 days if still there. */
export async function syncOpportunities(site: Pick<SiteRow, "id" | "owner_id">, opps: SeoOpportunities): Promise<void> {
  const items = flattenOpportunities(opps);
  for (const it of items) {
    await db()`insert into seo_opportunities (site_id, owner_id, type, key, page, query, impressions, clicks, position, data)
      values (${site.id}, ${site.owner_id}, ${it.type}, ${it.key}, ${it.page}, ${it.query}, ${it.impressions}, ${it.clicks}, ${it.position}, ${db().json(it.data as never)})
      on conflict (site_id, type, key) do update set page = excluded.page, query = excluded.query, impressions = excluded.impressions,
        clicks = excluded.clicks, position = excluded.position, data = excluded.data, last_seen = current_date,
        status = case when seo_opportunities.status = 'stale' then 'open'
                      when seo_opportunities.status in ('fixed', 'queued', 'suggested') and seo_opportunities.resolved_at < now() - interval '28 days' then 'open'
                      else seo_opportunities.status end,
        resolved_at = case when seo_opportunities.status = 'stale' then null
                           when seo_opportunities.status in ('fixed', 'queued', 'suggested') and seo_opportunities.resolved_at < now() - interval '28 days' then null
                           else seo_opportunities.resolved_at end`;
  }
  await db()`update seo_opportunities set status = 'stale' where site_id = ${site.id} and last_seen < current_date and status <> 'dismissed'`;
}

// ---------- 2. act ----------

const Rewrite = z.object({
  title: z.string().describe("Title tag, at most 60 characters, the exact top query near the front, a concrete number, benefit or year if the page supports it, brand last"),
  meta: z.string().describe("Meta description, 120 to 155 characters, answers the query and gives a reason to click"),
});

type RewriteInput = { page: string; query: string; queries: { query: string; impressions: number; clicks: number; position: number }[]; title: string | null; meta: string | null; h1: string | null; excerpt?: string | null };

/** One cheap call (plus one retry) for a better title and meta description. Null when it cannot produce a pair that passes the rules. */
export async function writeTitleMeta(site: SiteRow, inp: RewriteInput, budget: Budget): Promise<TitleMeta | null> {
  const styles = await titleStyles(site.id);
  let issues: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = noDashesDeep(await structured({
      model: MODELS.fast,
      purpose: "title_meta",
      budget,
      maxTokens: 800,
      schema: Rewrite,
      system: "You write the title tag and meta description for one web page so more searchers click it. Plain words, concrete, no hype. Use only facts that appear in the page details given. Never promise or imply a ranking, traffic, a guarantee or a result. No dashes as punctuation.",
      prompt: `Today's date: ${new Date().toISOString().slice(0, 10)}. Do not put a past year in the text.
Site: ${site.url} (${site.scan.name || site.name || site.domain})
Page: ${inp.page}
Current title tag: ${inp.title ?? "(unknown)"}
Current meta description: ${inp.meta ?? "(unknown)"}
Page H1: ${inp.h1 ?? "(unknown)"}
${inp.excerpt ? `Page summary: ${inp.excerpt}\n` : ""}Search Console, last 28 days, the searches this page shows up for:
${inp.queries.map((q) => `- "${q.query}" | ${q.impressions} impressions | ${q.clicks} clicks | position ${q.position}`).join("\n")}

${styles}
Write a new title tag and meta description for the top search "${inp.query}". The title: 60 characters at most, the exact search words near the front, a concrete number, year or benefit if the page supports it, the brand name last. The meta description: 120 to 155 characters, answers the search and gives a reason to click.${issues.length ? `\nYour last attempt failed these checks, fix them: ${issues.join("; ")}.` : ""}`,
    }));
    const clamped = { title: clampTitle(out.title) ?? out.title, meta: out.meta.trim() };
    issues = titleMetaIssues(clamped, inp.query);
    if (!issues.length) return clamped;
  }
  return null;
}

const topQueriesFor = async (siteId: string, page: string) =>
  (await db()`select lower(query) query, sum(impressions)::int impressions, sum(clicks)::int clicks,
      case when sum(impressions) > 0 then round((sum(position * impressions) / sum(impressions))::numeric, 1) else 0 end position
    from gsc_rows where site_id = ${siteId} and date > current_date - 28 and seo_page_path(page) = ${pathKey(page)}
    group by lower(query) order by sum(impressions) desc limit 5`) as unknown as RewriteInput["queries"];

export type ActResult = { queued: number; rewritten: number; suggested: number; log: string[] };

const MAX_QUEUED_PER_RUN = 2;
const MAX_OPEN_RANK_TOPICS = 4;
const MAX_REWRITES_PER_RUN = 5;

export async function actOnOpportunities(site: SiteRow): Promise<ActResult> {
  const res: ActResult = { queued: 0, rewritten: 0, suggested: 0, log: [] };
  const paid = site.plan !== "free" && !site.paused;

  // ---- new articles for needs_own_page and cluster ----
  if (paid) {
    const [{ n }] = await db()`select count(*)::int n from topic_ideas where site_id = ${site.id} and status = 'open' and opportunity_type is not null`;
    let room = Math.min(MAX_QUEUED_PER_RUN, MAX_OPEN_RANK_TOPICS - n);
    const open = await db()`select * from seo_opportunities where site_id = ${site.id} and status = 'open' and type in ('needs_own_page', 'cluster') order by impressions desc limit 10`;
    const { existingTopics, blockedTopics } = await import("@/lib/engine/topics");
    const known = [...(await existingTopics(site)), ...(await blockedTopics(site.id)),
      ...(await db()`select text, target_query from topic_ideas where site_id = ${site.id} and status = 'open'`).flatMap((r) => [r.text, r.target_query].filter(Boolean) as string[])];
    for (const o of open) {
      if (room <= 0) break;
      const d = o.data as Record<string, any>;
      const query = String(o.type === "cluster" ? d.queries?.[0] ?? d.term : o.query);
      if (!query || known.some((t) => overlap(t, query) >= 0.8)) {
        await db()`update seo_opportunities set status = 'fixed', action = 'An article for this search already exists or is queued.', resolved_at = now() where id = ${o.id}`;
        continue;
      }
      const barred = blockedReason(site, query);
      if (barred) {
        await db()`update seo_opportunities set status = 'fixed', action = ${`Not queued: ${barred}.`}, resolved_at = now() where id = ${o.id}`;
        continue;
      }
      const pos = d.position != null ? Math.round(Number(d.position)) : null;
      const reason = o.type === "cluster"
        ? `${d.query_count} searches about "${d.term}" show your site at positions 20 to 70 (${d.impressions} impressions in 28 days). One strong page on the topic, linked to the pages you already have, gives Google a clear page to show.`
        : `"${query}" already shows your site in Google (${o.impressions} impressions in 28 days${pos ? `, around position ${pos}` : ""}) but only through ${o.page}, which is not about it. A page built for this exact search is the better answer.`;
      const angle = o.type === "cluster"
        ? `The hub page for "${d.term}": answer the main search first, then cover these related searches in their own sections and link to the pages that already exist: ${(d.queries as string[]).join("; ")}.`
        : `A page written for this exact search. It currently shows up through ${o.page}, so link to that page where it helps the reader.`;
      const [idea] = await db()`insert into topic_ideas (site_id, owner_id, kind, text, target_query, angle, intent, reason, priority, opportunity_type)
        values (${site.id}, ${site.owner_id}, 'suggested', ${query.charAt(0).toUpperCase() + query.slice(1)}, ${query}, ${angle}, 'learning', ${reason}, 10, ${String(o.type)}) returning id`;
      await db()`update seo_opportunities set status = 'queued', action = ${`Queued as the next article: "${query}".`}, topic_idea_id = ${idea.id}, resolved_at = now() where id = ${o.id}`;
      known.push(query);
      room--;
      res.queued++;
      res.log.push(`queued "${query}" (${o.type})`);
    }
  }

  // ---- title and meta for ctr_fix ----
  const fixes = await db()`select * from seo_opportunities where site_id = ${site.id} and status = 'open' and type = 'ctr_fix' order by impressions desc limit ${MAX_REWRITES_PER_RUN}`;
  if (fixes.length) {
    const budget = new Budget({ ownerId: site.owner_id, siteId: site.id, articleId: null }, { usd: 0.25, tokens: 60_000, searches: 0 });
    for (const o of fixes) {
      try {
        const page = String(o.page);
        const queries = await topQueriesFor(site.id, page.startsWith("http") ? page : `${site.url.replace(/\/+$/, "")}${page}`);
        const query = queries[0]?.query ?? (o.query as string | null);
        if (!query) continue;
        const [art] = (await db()`select * from articles where site_id = ${site.id} and status = 'published' and kind = 'new' and published_url is not null
          and seo_page_path(published_url) = ${pathKey(page)} limit 1`) as unknown as ArticleRow[];
        const full = art?.published_url ? art.published_url : `${site.url.replace(/\/+$/, "")}${page}`;
        const [snap] = await db()`select title, meta_description, h1 from seo_page_snapshots where site_id = ${site.id} and page_key = ${normUrl(full)} order by fetched_on desc limit 1`;
        const [recent] = await db()`select 1 from seo_tests where site_id = ${site.id} and page_key = ${normUrl(full)} and changed_on > current_date - 28`;
        if (recent) { await db()`update seo_opportunities set status = 'fixed', action = 'Title changed in the last 28 days, waiting for the result.', resolved_at = now() where id = ${o.id}`; continue; }
        const tm = await writeTitleMeta(site, {
          page: full, query, queries,
          title: art?.meta_title ?? snap?.title ?? null, meta: art?.meta_description ?? snap?.meta_description ?? null, h1: art?.title ?? snap?.h1 ?? null, excerpt: art?.excerpt ?? null,
        }, budget);
        if (!tm) continue;
        if (art && canEditMeta(site) && paid) {
          await applyMeta(site, art, tm, query);
          await db()`update seo_opportunities set status = 'fixed', action = 'Paperboy rewrote the title and meta description.', suggestion = ${db().json(tm as never)}, article_id = ${art.id}, resolved_at = now() where id = ${o.id}`;
          res.rewritten++;
          res.log.push(`rewrote title/meta of ${page}`);
        } else {
          await db()`update seo_opportunities set status = 'suggested', action = ${art ? "Paperboy cannot change the title tag on this publishing method. Paste the suggestion into your site." : "This page is not one Paperboy publishes. Paste the suggestion into your site."},
            suggestion = ${db().json({ ...tm, current_title: art?.meta_title ?? snap?.title ?? null, current_meta: art?.meta_description ?? snap?.meta_description ?? null } as never)}, resolved_at = now() where id = ${o.id}`;
          res.suggested++;
        }
      } catch (e) {
        res.log.push(`ctr_fix ${o.page}: ${(e as Error).message}`);
        if (/cap|Cost cap|Stopped/i.test((e as Error).message)) break;
      }
    }
  }
  return res;
}

/** Writes a new title tag and meta description to a published article and its live page, and starts the 28 day test. */
async function applyMeta(site: SiteRow, a: ArticleRow, tm: TitleMeta, query: string) {
  const next = { ...a, meta_title: tm.title, meta_description: tm.meta } as ArticleRow;
  // Hosted and paste-prompt pages read these columns directly; Ghost and webhook sites are updated through the publisher.
  if (site.publish_method === "ghost" || site.publish_method === "webhook") {
    await publishArticle(site, next, { externalId: a.external_id, url: a.published_url });
  }
  await db()`update articles set meta_title = ${tm.title}, meta_description = ${tm.meta}, updated_content_at = now() where id = ${a.id}`;
  await db()`insert into seo_tests (site_id, owner_id, page_key, page, source, old_title, new_title, old_meta, new_meta, target_query)
    values (${site.id}, ${site.owner_id}, ${normUrl(a.published_url!)}, ${a.published_url}, 'paperboy', ${a.meta_title}, ${tm.title}, ${a.meta_description}, ${tm.meta}, ${query})`;
  await db()`insert into insights (site_id, owner_id, article_id, kind, text) values (${site.id}, ${site.owner_id}, ${a.id}, 'note',
    ${`New title and meta description for "${a.title}", written for the search "${query}" because it shows up in Google but gets few clicks. The result is measured in 28 days.`})`;
  await pingIndexNow(site, a.published_url!).catch(() => undefined);
}

/** A published article that a slipping, push_to_1 or striking_distance opportunity points at, for the weekly refresh in scheduleDue. */
export async function rankLoopRefreshCandidate(siteId: string): Promise<{ id: string; title: string; position: number; impressions: number; clicks: number } | null> {
  const [r] = await db()`
    select a.id, a.title, o.position, o.impressions, o.clicks
    from seo_opportunities o join articles a on a.site_id = o.site_id and a.status = 'published' and a.kind = 'new' and a.published_url is not null
      and seo_page_path(a.published_url) = seo_page_path(o.page)
    where o.site_id = ${siteId} and o.status = 'open' and o.type in ('slipping', 'push_to_1', 'striking_distance') and o.page <> '/'
      and a.published_at < now() - interval '14 days'
      and coalesce(a.updated_content_at, a.published_at) < now() - interval '28 days'
      and not exists (select 1 from articles r where r.refresh_of = a.id and r.created_at > now() - interval '28 days')
    order by (o.type = 'slipping') desc, o.impressions desc limit 1`;
  return r ? { id: r.id, title: r.title, position: Number(r.position ?? 0), impressions: r.impressions, clicks: r.clicks } : null;
}

// ---------- 3. measure ----------

/** Fetches the top pages' title and meta once a day, logs a change, and returns how many pages were read. */
export async function snapshotPages(site: SiteRow, rows: OppRow[], budgetMs = 120_000): Promise<{ read: number; changes: number }> {
  const started = Date.now();
  const pages = pagesToWatch(rows, site.url);
  let read = 0, changes = 0;
  const queue = pages.slice();
  const work = async () => {
    for (let url = queue.shift(); url && Date.now() - started < budgetMs; url = queue.shift()) {
      try {
        const p = await fetchPage(url, 10_000);
        const snap: Snapshot = { title: p.title || null, meta_description: p.description || null, h1: p.root.querySelector("h1")?.text.trim().replace(/\s+/g, " ") || null };
        const key = normUrl(url);
        const [prev] = await db()`select title, meta_description, h1 from seo_page_snapshots where site_id = ${site.id} and page_key = ${key} and fetched_on < current_date order by fetched_on desc limit 1`;
        await db()`insert into seo_page_snapshots (site_id, page_key, page, title, meta_description, h1) values (${site.id}, ${key}, ${url}, ${snap.title}, ${snap.meta_description}, ${snap.h1})
          on conflict (site_id, page_key, fetched_on) do update set title = excluded.title, meta_description = excluded.meta_description, h1 = excluded.h1`;
        read++;
        const change = diffTitleMeta(prev as Snapshot | undefined ?? null, snap);
        if (!change) continue;
        const recent = await db()`select page_key, changed_on::text changed_at from seo_tests where site_id = ${site.id} and page_key = ${key} and changed_on > current_date - 7`;
        if (recentlyLogged(recent.map((r) => ({ page_url: r.page_key, changed_at: r.changed_at })), url)) continue;
        const [top] = await topQueriesFor(site.id, url);
        await db()`insert into seo_tests (site_id, owner_id, page_key, page, source, old_title, new_title, old_meta, new_meta, target_query)
          values (${site.id}, ${site.owner_id}, ${key}, ${url}, 'detected', ${change.old.title}, ${change.new.title}, ${change.old.meta}, ${change.new.meta}, ${top?.query ?? null})`;
        changes++;
      } catch { /* a page that does not load today is tried again tomorrow */ }
    }
  };
  await Promise.all([work(), work(), work()]);
  return { read, changes };
}

const windowStats = async (siteId: string, key: string, from: string, to: string): Promise<Stats> => {
  const [r] = await db()`select coalesce(sum(clicks), 0)::int clicks, coalesce(sum(impressions), 0)::int impressions,
      case when sum(impressions) > 0 then sum(position * impressions) / sum(impressions) end position
    from gsc_rows where site_id = ${siteId} and date >= ${from}::date and date < ${to}::date and seo_page_path(page) = ${pathKey(key)}`;
  return { clicks: r.clicks, impressions: r.impressions, position: r.position == null ? null : Number(r.position) };
};

/** Scores every change that is old enough: 28 days of Search Console before against 28 days after. */
export async function measureTests(siteId: string): Promise<number> {
  const due = await db()`select id, page_key, changed_on::text changed_on from seo_tests
    where site_id = ${siteId} and outcome = 'pending' and changed_on <= current_date - ${MEASURE_AFTER_DAYS}::int limit 50`;
  const add = (d: string, n: number) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
  for (const t of due) {
    const before = await windowStats(siteId, t.page_key, add(t.changed_on, -28), t.changed_on);
    const after = await windowStats(siteId, t.page_key, add(t.changed_on, 1), add(t.changed_on, 29));
    const { outcome, note } = scoreTest(before, after);
    await db()`update seo_tests set outcome = ${outcome}, before_stats = ${db().json(before as never)}, after_stats = ${db().json({ ...after, note } as never)}, measured_at = now() where id = ${t.id}`;
  }
  return due.length;
}

// ---------- status ----------

export async function loadStats(siteId: string): Promise<LoopStats> {
  const [s] = await db()`select gsc_property, gsc_connected_at::text connected, (select max(date)::text from gsc_rows where site_id = ${siteId}) last_data from sites where id = ${siteId}`;
  const open = await db()`select type, count(*)::int n from seo_opportunities where site_id = ${siteId} and status = 'open' group by type`;
  const [f] = await db()`select count(distinct page_key) filter (where created_at >= now() - interval '7 days')::int f7,
      count(distinct page_key) filter (where created_at >= now() - interval '28 days')::int f28, max(created_at)::text last_fix,
      count(*) filter (where outcome = 'win')::int w, count(*) filter (where outcome = 'loss')::int l,
      count(*) filter (where outcome = 'neutral')::int n, count(*) filter (where outcome = 'pending')::int p
    from seo_tests where site_id = ${siteId}`;
  return {
    hasProperty: !!s?.gsc_property, lastDataDate: s?.last_data ?? null, trackingSince: s?.connected ?? null,
    open: Object.fromEntries(open.map((r) => [r.type, r.n])) as Partial<OppCounts>,
    fixes7d: f.f7, fixes28d: f.f28, lastFixAt: f.last_fix, tests: { win: f.w, loss: f.l, neutral: f.n, pending: f.p },
  };
}

export const loadRankLoopStatus = async (siteId: string) => rankLoopStatus(await loadStats(siteId));

/** Every site's status for the admin panel, worst first. */
export async function loadAllStatuses() {
  const sites = await db()`select id, domain, plan from sites order by (plan <> 'free') desc, created_at desc limit 300`;
  const out = [];
  for (const s of sites) out.push({ siteId: s.id as string, domain: s.domain as string, plan: s.plan as string, ...(await loadRankLoopStatus(s.id)) });
  return sortRankLoop(out);
}

// ---------- the daily run ----------

export async function runRankLoop(siteId: string): Promise<string[]> {
  const [site] = (await db()`select * from sites where id = ${siteId}`) as unknown as SiteRow[];
  if (!site?.gsc_property) return [`${siteId}: no Search Console`];
  const log: string[] = [];
  const rows = await loadOppRows(siteId);
  if (!rows.some((r) => r.win === "cur" && r.impressions > 0)) return [`${site.domain}: no Search Console rows in the last 28 days`];
  const opps = computeOpportunities(rows);
  await syncOpportunities(site, opps);
  const snap = await snapshotPages(site, rows).catch((e) => ({ read: 0, changes: 0, err: (e as Error).message }));
  log.push(`${site.domain}: ${snap.read} pages read, ${snap.changes} title changes seen`);
  log.push(`measured ${await measureTests(siteId).catch(() => 0)} tests`);
  const act = await actOnOpportunities(site).catch((e) => ({ queued: 0, rewritten: 0, suggested: 0, log: [`act failed: ${(e as Error).message}`] }));
  log.push(`queued ${act.queued}, rewrote ${act.rewritten}, suggested ${act.suggested}`, ...act.log);
  return log;
}

export { pathOf };
