// Step 1: pick the topic. Search Console data first (page-two queries, questions with no page, topics next to what
// already gets clicks); web research for sites with no data. Never a topic that overlaps an existing article.
import { z } from "zod";
import { MODELS } from "@/config/models";
import { searchTurn, structured, type Budget } from "@/lib/ai/client";
import { sql } from "@/lib/db";
import type { SiteRow } from "@/lib/types";
import { noDashesDeep, overlap, QUESTION_RE } from "@/lib/util";
import { BLOCKED_ALTERNATIVES } from "@/config/serp-gate";
import { blockedReason } from "./blocklist";

export type QueryStat = { query: string; clicks: number; impressions: number; position: number; page: string };

export type Signals = {
  hasData: boolean;
  pageTwo: QueryStat[];
  questions: QueryStat[];
  nearClicks: QueryStat[];
};

export async function gscSignals(siteId: string, days = 28): Promise<Signals> {
  const db = sql();
  const rows = (await db`
    with q as (
      select query, sum(clicks)::int clicks, sum(impressions)::int impressions,
        case when sum(impressions) > 0 then sum(position * impressions) / sum(impressions) else 0 end position
      from gsc_rows where site_id = ${siteId} and date >= current_date - ${days}::int group by query
    ), p as (
      select distinct on (query) query, page from (
        select query, page, sum(impressions) imp from gsc_rows where site_id = ${siteId} and date >= current_date - ${days}::int group by query, page
      ) x order by query, imp desc
    )
    select q.*, p.page from q join p using (query) order by impressions desc limit 2000`) as unknown as QueryStat[];
  const r = (x: QueryStat) => ({ ...x, position: Math.round(Number(x.position) * 10) / 10 });
  const all = rows.map(r);
  return {
    hasData: all.length > 0,
    pageTwo: all.filter((x) => x.position > 10.5 && x.position <= 20.5 && x.impressions >= 5).slice(0, 40),
    questions: all.filter((x) => QUESTION_RE.test(x.query) && (x.position > 8 || x.clicks === 0) && x.impressions >= 3).slice(0, 40),
    nearClicks: all.filter((x) => x.clicks > 0).sort((a, b) => b.clicks - a.clicks).slice(0, 25),
  };
}

export async function existingTopics(site: SiteRow): Promise<string[]> {
  const db = sql();
  const rows = await db`select coalesce(title, topic) t, target_query q from articles where site_id = ${site.id} and status <> 'failed' and kind = 'new'`;
  const out = rows.flatMap((r) => [r.t, r.q]).filter(Boolean) as string[];
  for (const p of site.scan.existing_posts ?? []) out.push(p.title);
  return [...new Set(out)];
}

const Pick = z.object({
  topic: z.string().describe("Working title for the article, specific and plain"),
  target_query: z.string().describe("The exact search the article should rank for"),
  angle: z.string().describe("One or two sentences: what the article covers that the existing pages and top results do not"),
  intent: z.enum(["buying", "comparing", "problem", "learning"]),
  signal: z.enum(["page_two", "question_gap", "near_clicks", "research"]),
  reason: z.string().describe("At most 45 words. One or two plain sentences for the customer explaining why this topic, citing the numbers, e.g. 'Your pricing page is on page two for 14 searches about X, so this article answers the closest question.'"),
});
export type TopicPick = z.infer<typeof Pick>;

const INTENTS = Pick.shape.intent.options as readonly string[];

/**
 * A queued topic that already carries its own search phrase (suggestions, and ideas inserted with a brief in `angle`) is written as
 * stored: the brief reaches research and the writer instead of being replaced by the model's own one-line angle. Ideas typed in the
 * app have no search phrase, so they return null and the model still shapes them (pickTopic with `requested`).
 */
export function storedTopic(q: { text: string; target_query?: string | null; angle?: string | null; intent?: string | null; reason?: string | null } | undefined | null): TopicPick | null {
  if (!q?.target_query) return null;
  const intent = q.intent === "commercial" ? "buying" : q.intent && INTENTS.includes(q.intent) ? q.intent : "learning";
  return { topic: q.text, target_query: q.target_query, angle: q.angle ?? "", intent: intent as TopicPick["intent"], signal: "research", reason: q.reason ?? "" };
}

const SYSTEM =
  "You are the editor who decides what a small company's website should publish next to be useful to the people searching and to match what the site really offers. Prefer topics with buying intent (comparisons, costs, how to choose, alternatives, problems the product solves) over general definitions. Never pick a topic an existing article already covers from the same angle. Plain words, no hype, no em dashes.";

function siteBrief(site: SiteRow) {
  const s = site.scan;
  return `SITE: ${site.url}
What they do: ${s.what_you_do ?? ""}
Who they serve: ${s.who_you_serve ?? ""}
Main offer: ${s.offer ?? ""}`;
}

const fmt = (xs: QueryStat[]) => xs.map((x) => `"${x.query}" | ${x.impressions} impressions | ${x.clicks} clicks | position ${x.position} | ${x.page}`).join("\n");

/** Topics the customer said never to write about. */
export async function blockedTopics(siteId: string): Promise<string[]> {
  return (await sql()`select text from topic_ideas where site_id = ${siteId} and kind = 'block'`).map((r) => r.text as string);
}

const blockedBlock = (blocked: string[], site?: Pick<SiteRow, "id">) => {
  // Paperboy's own site: no new "[big competitor] alternatives" posts while its authority is low (config/serp-gate.ts).
  const own = site && blockedReason(site, "surfer alternatives") ? `\nNEVER pick an "alternatives to" topic for these companies (their search results are out of reach for a young domain): ${BLOCKED_ALTERNATIVES.map((c) => c.name).join(", ")}.\n` : "";
  return (blocked.length ? `\nTOPICS THE CUSTOMER NEVER WANTS (avoid these and anything close to them):\n${blocked.map((t) => `- ${t}`).join("\n")}\n` : "") + own;
};

const clashes = (pick: { topic: string; target_query: string }, against: string[]) =>
  against.find((t) => overlap(t, pick.topic) >= 0.75 || overlap(t, pick.target_query) >= 0.8);

/**
 * Picks the next article. `requested` is a topic the customer asked for: it becomes the article, and the model only
 * shapes it (the search to target, the angle, the reason).
 */
export async function pickTopic(site: SiteRow, budget: Budget, exclude: string[] = [], requested?: string): Promise<TopicPick> {
  const signals: Signals = await gscSignals(site.id);
  const existing = [...(await existingTopics(site)), ...exclude];
  const blocked = await blockedTopics(site.id);
  const existingBlock = existing.length ? existing.slice(0, 150).map((t) => `- ${t}`).join("\n") : "- none yet";

  let research = "";
  if (!requested && (!signals.hasData || (signals.pageTwo.length + signals.questions.length < 3))) {
    // No Search Console data: find what buyers in this market search for, using at most 2 of the article's 6 searches.
    const r = await searchTurn({
      budget,
      purpose: "topic_research",
      maxSearches: 2,
      maxTokens: 5000,
      system: "You research what potential customers search for before they buy. Report real questions and comparisons people search, with the page you saw them on.",
      prompt: `${siteBrief(site)}

Search the web for the questions and comparisons that people who might buy this would search before buying (cost, how to choose, alternatives, problems, "X vs Y"). Then list 10 candidate article topics in plain words, each with the search phrase and why a buyer would search it. Leave out anything already covered here:
${existingBlock}`,
    });
    research = r.text.slice(0, 6000);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const pick = noDashesDeep(await structured({
      model: MODELS.fast,
      purpose: "topic_pick",
      budget,
      maxTokens: 4000,
      schema: Pick,
      system: SYSTEM,
      prompt: `Today's date: ${new Date().toISOString().slice(0, 10)}. Do not put a past year in the topic.

${siteBrief(site)}

${signals.hasData ? `SEARCH CONSOLE, LAST 28 DAYS
Queries on page two (positions 11 to 20), the closest wins:
${fmt(signals.pageTwo) || "none"}

Questions people search where the site has no strong page:
${fmt(signals.questions) || "none"}

Queries that already get clicks (write next to these):
${fmt(signals.nearClicks) || "none"}` : "SEARCH CONSOLE: not connected or no data yet."}
${research ? `\nWEB RESEARCH ON WHAT BUYERS SEARCH:\n${research}` : ""}

ARTICLES AND PAGES THAT ALREADY EXIST (do not overlap these):
${existingBlock}
${blockedBlock(blocked, site)}
${requested ? `THE CUSTOMER ASKED FOR THIS ARTICLE: "${requested}"
Write this one. Shape it: choose the exact search a buyer would type for it, the angle that beats what exists, and a reason that says it was the customer's idea (plus any numbers above that support it).` : `Pick the single best next article.`} Order of preference: a page-two query you can win with a dedicated article, then a question with no page, then a topic next to what already gets clicks, then research. The reason must quote the real numbers above when there are any.`,
    }));
    // A customer's own idea is written even if it sits close to an older article; everything else must be new.
    const clash = requested ? clashes(pick, blocked) : clashes(pick, [...existing, ...blocked]) ?? blockedReason(site, pick.topic, pick.target_query);
    if (!clash) return pick;
    exclude.push(pick.topic);
    existing.push(pick.topic);
  }
  throw new Error("Could not find a topic that does not repeat an existing article. Add a topic idea in Settings, or connect Search Console.");
}

const Suggestions = z.object({ topics: z.array(Pick).describe("Distinct article topics, best first") });

/**
 * The next few articles Paperboy would write, decided ahead of time. Shown after the free article and on the
 * overview, so people see exactly what they would get; used in order once they subscribe. One cheap call, no search.
 */
export async function suggestTopics(site: SiteRow, budget: Budget, n = 3): Promise<TopicPick[]> {
  const signals: Signals = await gscSignals(site.id);
  const queued = (await sql()`select text from topic_ideas where site_id = ${site.id} and status = 'open' and kind in ('idea','suggested')`).map((r) => r.text as string);
  const existing = [...(await existingTopics(site)), ...queued];
  const blocked = await blockedTopics(site.id);
  const out = noDashesDeep(await structured({
    model: MODELS.fast,
    purpose: "topic_suggest",
    budget,
    maxTokens: 4000,
    schema: Suggestions,
    system: SYSTEM,
    prompt: `Today's date: ${new Date().toISOString().slice(0, 10)}. Do not put a past year in a topic.

${siteBrief(site)}

${signals.hasData ? `SEARCH CONSOLE, LAST 28 DAYS
Page two (positions 11 to 20):
${fmt(signals.pageTwo.slice(0, 25)) || "none"}
Questions with no strong page:
${fmt(signals.questions.slice(0, 25)) || "none"}` : "SEARCH CONSOLE: not connected or no data yet. Use what buyers of this business would search before buying."}

ARTICLES, PAGES AND QUEUED TOPICS THAT ALREADY EXIST (do not overlap these or each other):
${existing.length ? existing.slice(0, 150).map((t) => `- ${t}`).join("\n") : "- none yet"}
${blockedBlock(blocked, site)}
List the ${n} best next articles, each a different search, buying intent first. Each reason is one plain sentence for the business owner.`,
  }));
  const picked: TopicPick[] = [];
  for (const t of out.topics) {
    if (clashes(t, [...existing, ...blocked, ...picked.map((p) => p.topic)]) || blockedReason(site, t.topic, t.target_query)) continue;
    picked.push(t);
    if (picked.length >= n) break;
  }
  return picked;
}

/** Published articles that underperform and are worth a refresh: page two or low click-through after 28 days. */
export async function refreshCandidates(siteId: string) {
  const db = sql();
  return db`
    select a.id, a.title, a.published_url, sum(g.impressions)::int impressions, sum(g.clicks)::int clicks,
      case when sum(g.impressions) > 0 then sum(g.position * g.impressions) / sum(g.impressions) else 0 end position
    from articles a join gsc_rows g on g.site_id = a.site_id and g.page = a.published_url and g.date >= current_date - 28
    where a.site_id = ${siteId} and a.status = 'published' and a.kind = 'new'
      and a.published_at < now() - interval '28 days'
      and coalesce(a.updated_content_at, a.published_at) < now() - interval '45 days'
      and not exists (select 1 from articles r where r.refresh_of = a.id and r.created_at > now() - interval '45 days')
    group by a.id
    having sum(g.impressions) >= 50 and (
      (sum(g.position * g.impressions) / sum(g.impressions)) between 8 and 25
      or sum(g.clicks)::float / greatest(sum(g.impressions), 1) < 0.01)
    order by sum(g.impressions) desc limit 5`;
}
