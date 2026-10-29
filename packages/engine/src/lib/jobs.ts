// SPDX-License-Identifier: AGPL-3.0-only
// Background work: start an article, decide what is due, the daily Search Console pull and the weekly report.
import { appUrl } from "@/config/brand";
import { PLANS, type PlanId } from "@/config/plans";
import { sql } from "@/lib/db";
import { button, layout, p, sendEmail } from "@/lib/email";
import { syncSite } from "@/lib/gsc";
import { EXHAUSTED_COOLDOWN_HOURS } from "@/config/serp-gate";
import { inCooldown } from "@/lib/engine/serp-gate";
import { refreshCandidates } from "@/lib/engine/topics";
import { rankLoopRefreshCandidate } from "@/lib/rankloop/run";
import { escapeHtml, fmtInt, fmtPos } from "@/lib/util";

/**
 * Where the background functions live, or null to run work in-process (local development).
 * NETLIFY is only set during builds, so at runtime we also look for the variables Netlify sets in functions
 * (SITE_ID, AWS_LAMBDA_FUNCTION_NAME) and use our own app URL. Running an article inside a web request on Netlify
 * would freeze it as soon as the request returns.
 */
function workerBase(): string | null {
  const onNetlify = !!(process.env.NETLIFY || process.env.SITE_ID || process.env.AWS_LAMBDA_FUNCTION_NAME || (process.env.NODE_ENV === "production" && process.env.NETLIFY_SITE_ID));
  if (!onNetlify) return null;
  return (process.env.URL || process.env.NEXT_PUBLIC_APP_URL || process.env.DEPLOY_URL || "").replace(/\/+$/, "") || null;
}

/** Starts the article worker. On Netlify this is a background function (15 minute limit); locally it runs in-process. */
export async function kickArticle(articleId: string) {
  const base = workerBase();
  if (base) {
    await fetch(`${base}/.netlify/functions/article-worker-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-worker-secret": process.env.APP_SECRET ?? "" },
      body: JSON.stringify({ articleId }),
    }).catch((e) => console.error("kick failed", e));
    return;
  }
  const { runArticle } = await import("@/lib/engine/pipeline");
  void runArticle(articleId).catch((e) => console.error("article run failed", e));
}

/** Runs a longer job off the request: the jobs background function on Netlify, in-process locally. */
export async function runInBackground(job: "gsc-site" | "schedule" | "gsc" | "weekly" | "suggest" | "rankloop" | "results", payload: Record<string, unknown> = {}) {
  const base = workerBase();
  if (base) {
    await fetch(`${base}/.netlify/functions/jobs-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-worker-secret": process.env.APP_SECRET ?? "" },
      body: JSON.stringify({ job, ...payload }),
    }).catch((e) => console.error("background job failed to start", e));
    return;
  }
  void runJob(job, payload).catch((e) => console.error(`job ${job} failed`, e));
}

export async function runJob(job: string, payload: Record<string, unknown> = {}): Promise<string[]> {
  if (job === "gsc-site") {
    const n = await syncSite(String(payload.siteId), Number(payload.days ?? 90));
    const log = [`${payload.siteId}: ${n} rows`];
    return log;
  }
  if (job === "gsc") return dailyGsc();
  if (job === "weekly") return weeklyReports();
  if (job === "rankloop") {
    const { runRankLoop } = await import("@/lib/rankloop/run");
    return runRankLoop(String(payload.siteId));
  }
  if (job === "suggest") {
    // Fill the topic suggestions for one site, or for every site that has none (backfill).
    const { refillSuggestions } = await import("@/lib/engine/pipeline");
    const db = sql();
    const sites = payload.siteId
      ? await db`select * from sites where id = ${String(payload.siteId)}`
      : await db`select s.* from sites s where not exists (select 1 from topic_ideas t where t.site_id = s.id and t.kind = 'suggested') limit 50`;
    const log: string[] = [];
    for (const s of sites) {
      try { await refillSuggestions(s as never); log.push(`${s.domain}: ok`); } catch (e) { log.push(`${s.domain}: ${(e as Error).message}`); }
    }
    return log;
  }
  if (job === "schedule") return scheduleDue();
  return [];
}

/** Creates the planned articles each paid site is due this hour, and restarts anything stuck. Runs hourly. */
export async function scheduleDue(): Promise<string[]> {
  const db = sql();
  const log: string[] = [];
  const sites = await db`select * from sites where not paused`;
  for (const s of sites) {
    // A self-hosted site has no billing: its plan only sets the pace. Unknown plans use PAPERBOY_ARTICLES_PER_WEEK (default 3).
    const perWeek = PLANS[s.plan as PlanId]?.perWeek ?? (Number(process.env.PAPERBOY_ARTICLES_PER_WEEK) || 3);
    const [c] = await db`select count(*) filter (where created_at > now() - interval '7 days' and status <> 'failed')::int week,
      count(*) filter (where status in ('planned','picking','researching','writing','checking','fixing','publishing'))::int flying,
      max(created_at) last from articles where site_id = ${s.id}`;
    if (c.flying > 0 || c.week >= perWeek) continue;
    // Every candidate topic was skipped by the SERP gate a moment ago: do not start another article (and another round of searches) yet.
    if (await inCooldown(s.id, EXHAUSTED_COOLDOWN_HOURS)) continue;
    const gapHours = (168 / perWeek) * 0.85;
    if (c.last && Date.now() - new Date(c.last).getTime() < gapHours * 3600e3) continue;
    // One refresh of an underperforming article per week, when Search Console shows one.
    const [recentRefresh] = await db`select 1 from articles where site_id = ${s.id} and kind = 'refresh' and created_at > now() - interval '7 days'`;
    // Rank loop first: a slipping page or a query near the top beats the generic page-two / low click-through pick.
    const loopPick = recentRefresh ? null : await rankLoopRefreshCandidate(s.id).catch(() => null);
    const cands = recentRefresh ? [] : loopPick ? [loopPick] : perWeek < 3 ? [] : await refreshCandidates(s.id).catch(() => []);
    let id: string;
    if (cands[0]) {
      const r = cands[0];
      const reason = `"${r.title}" is at position ${fmtPos(Number(r.position))} with ${fmtInt(r.impressions)} impressions and ${fmtInt(r.clicks)} clicks in 28 days, so it is being refreshed to move it up.`;
      const [a] = await db`insert into articles (site_id, owner_id, kind, refresh_of, topic, target_query, angle, intent, reason, status)
        select ${s.id}, ${s.owner_id}, 'refresh', id, title, coalesce(target_query, title), coalesce(angle, '') || ' Refresh: make it the best answer on the page-two queries, add missing questions, tighten the opening.', intent, ${reason}, 'planned'
        from articles where id = ${r.id} returning id`;
      await db`insert into insights (site_id, owner_id, article_id, kind, text) values (${s.id}, ${s.owner_id}, ${a.id}, 'refresh', ${reason})`;
      id = a.id;
    } else {
      const [a] = await db`insert into articles (site_id, owner_id, status) values (${s.id}, ${s.owner_id}, 'planned') returning id`;
      id = a.id;
    }
    await kickArticle(id);
    log.push(`${s.domain}: started ${id}`);
  }
  // A planned article that was kicked but never got a worker (for example while the host was down) stays 'planned'
  // and counts as in flight, which blocks its site's schedule. Give up on it after a few tries so the site moves on.
  const dead = await db`update articles set status = 'failed', locked_until = null, review_reason = 'error',
    review_note = 'This article could not be started. Press "Try again" to restart it.'
    where status = 'planned' and attempts >= 4 and created_at < now() - interval '10 minutes' and (locked_until is null or locked_until < now())
    returning id`;
  for (const a of dead) log.push(`gave up on ${a.id}`);
  // Restart planned articles that never started, and stalled ones whose lock expired.
  const stuck = await db`select id from articles where (status = 'planned' and created_at < now() - interval '10 minutes' and attempts < 4
      and (locked_until is null or locked_until < now()))
    or (status in ('picking','researching','writing','checking','fixing','publishing') and locked_until < now()) limit 20`;
  for (const a of stuck) {
    await db`update articles set status = 'planned', locked_until = null where id = ${a.id} and status <> 'published'`;
    await kickArticle(a.id);
    log.push(`restarted ${a.id}`);
  }
  return log;
}

/** Daily: pull the last five days of Search Console data for every connected site. */
export async function dailyGsc(): Promise<string[]> {
  const db = sql();
  const log: string[] = [];
  const sites = await db`select id, domain from sites where gsc_property is not null`;
  for (const s of sites) {
    try {
      const n = await syncSite(s.id, 5);
      log.push(`${s.domain}: ${n} rows`);
      await performanceInsights(s.id);
      // The rank loop (opportunities, title/meta fixes, 28 day scoring) runs per site in its own background function.
      await runInBackground("rankloop", { siteId: s.id });
    } catch (e) {
      log.push(`${s.domain}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return log;
}

/** Plain-language notes on published articles that sit on page two (feeds the dashboard's "why" panel). */
async function performanceInsights(siteId: string) {
  const db = sql();
  const rows = await db`
    select a.id, a.title, a.owner_id, count(distinct g.query)::int queries, sum(g.impressions)::int impressions,
      sum(g.position * g.impressions) / nullif(sum(g.impressions), 0) position
    from articles a join gsc_rows g on g.site_id = a.site_id and g.page = a.published_url and g.date >= current_date - 28
    where a.site_id = ${siteId} and a.status = 'published' group by a.id
    having sum(g.position * g.impressions) / nullif(sum(g.impressions), 0) between 10.5 and 20.5 order by impressions desc limit 3`;
  for (const r of rows) {
    const text = `"${r.title}" is on page two for ${r.queries} search${r.queries === 1 ? "" : "es"} (average position ${fmtPos(Number(r.position))}), so the next article covers a related question and links back to it.`;
    const [dup] = await db`select 1 from insights where site_id = ${siteId} and article_id = ${r.id} and kind = 'performance' and created_at > now() - interval '7 days'`;
    if (!dup) await db`insert into insights (site_id, owner_id, article_id, kind, text) values (${siteId}, ${r.owner_id}, ${r.id}, 'performance', ${text})`;
  }
}

/** Weekly: one email per site with what got traffic, what was published and what is next. */
export async function weeklyReports(): Promise<string[]> {
  const db = sql();
  const log: string[] = [];
  const sites = await db`select s.*, p.email from sites s join profiles p on p.id = s.owner_id where p.weekly_report
    and exists (select 1 from articles a where a.site_id = s.id and a.status = 'published')`;
  for (const s of sites) {
    const [t] = await db`select coalesce(sum(clicks),0)::int clicks, coalesce(sum(impressions),0)::int impressions from gsc_rows where site_id = ${s.id} and date >= current_date - 7`;
    const top = await db`select a.title, a.published_url, sum(g.clicks)::int clicks from articles a join gsc_rows g on g.page = a.published_url and g.site_id = a.site_id
      where a.site_id = ${s.id} and g.date >= current_date - 7 group by a.id order by clicks desc limit 3`;
    const published = await db`select title, published_url from articles where site_id = ${s.id} and status = 'published' and published_at > now() - interval '7 days' order by published_at desc`;
    const next = await db`select coalesce(topic, 'Topic being picked') topic, status from articles where site_id = ${s.id} and status not in ('published','failed') order by created_at limit 3`;
    const [why] = await db`select text from insights where site_id = ${s.id} and kind in ('next_topic','performance','refresh') order by created_at desc limit 1`;
    const li = (items: string[]) => items.length ? `<ul style="padding-left:18px;margin:0 0 14px">${items.map((x) => `<li style="margin:0 0 6px">${x}</li>`).join("")}</ul>` : p("Nothing yet.");
    const html = layout(`Your week on ${s.domain}`, [
      p(`<strong>${fmtInt(t.clicks)}</strong> clicks and <strong>${fmtInt(t.impressions)}</strong> impressions from Google in the last 7 days.`),
      `<h2 style="font-size:17px;margin:20px 0 8px">What got traffic</h2>`,
      li(top.map((r) => `<a href="${escapeHtml(r.published_url)}">${escapeHtml(r.title)}</a>: ${fmtInt(r.clicks)} clicks`)),
      `<h2 style="font-size:17px;margin:20px 0 8px">Published this week</h2>`,
      li(published.map((r) => `<a href="${escapeHtml(r.published_url)}">${escapeHtml(r.title)}</a>`)),
      `<h2 style="font-size:17px;margin:20px 0 8px">Being written next</h2>`,
      li(next.map((r) => escapeHtml(r.topic))),
      why ? p(`<em>Why:</em> ${escapeHtml(why.text)}`) : "",
      p(button(appUrl(`/app/sites/${s.id}`), "Open your dashboard")),
    ].join(""));
    const res = await sendEmail(s.email, `Your week on ${s.domain}`, html, `Your week on ${s.domain}: ${t.clicks} clicks, ${t.impressions} impressions.`);
    log.push(`${s.domain}: ${res.sent ? "sent" : res.reason}`);
  }
  return log;
}
