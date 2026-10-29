// Step 1 with the gates on: choose the topic for an article, skipping candidates the own-site blocklist forbids and
// candidates whose search results page is too strong to win (see serp-gate.ts). A skip never costs the customer an
// article: the next candidate is tried in the same run, and a round with no usable candidate removes the empty
// placeholder so the weekly quota is untouched.
import { MAX_TOPIC_TRIES } from "@/config/serp-gate";
import { Budget } from "@/lib/ai/client";
import { sql } from "@/lib/db";
import type { ArticleRow, SiteRow } from "@/lib/types";
import { blockedReason } from "./blocklist";
import { checkSerp, logGate, recentlySkipped, type GateLogEntry, type GateResult } from "./serp-gate";
import { pickTopic, storedTopic, type TopicPick } from "./topics";

export type Queued = { id: string; text: string; target_query?: string | null; angle?: string | null; intent?: string | null; reason?: string | null };
export type Chosen = { topic: TopicPick; queued: Queued | null; gate: GateResult | null; overridden: boolean };

/** Everything the choice touches outside itself, so tests can run it with a mock SERP and no database. */
export type Io = {
  nextQueued(): Promise<Queued | null>;
  pick(exclude: string[], requested?: string): Promise<TopicPick>;
  check(query: string): Promise<GateResult>;
  skipIdea(id: string, why: string): Promise<void>;
  log(e: Omit<GateLogEntry, "siteId" | "articleId">): Promise<void>;
  skipped(): Promise<string[]>;
  progress(note: string): Promise<void>;
};

export async function chooseTopic(site: Pick<SiteRow, "id">, isFree: boolean, io: Io, tries = MAX_TOPIC_TRIES): Promise<Chosen | null> {
  const exclude = await io.skipped();
  let weakest: (Chosen & { share: number }) | null = null;
  for (let i = 0; i < tries; i++) {
    const queued = await io.nextQueued();
    await io.progress(queued ? `Shaping your topic idea: "${queued.text}"` : i ? "Picking another topic" : "Reading your Search Console data and existing articles to pick the topic");
    let topic: TopicPick;
    try {
      topic = storedTopic(queued) ?? (await io.pick(exclude, queued?.text));
    } catch (e) {
      if (i === 0) throw e;
      break; // earlier candidates were skipped and nothing new can be found: end the round instead of failing the article
    }
    const label = { topic: topic.topic, query: topic.target_query };
    const blocked = blockedReason(site, topic.topic, topic.target_query);
    if (blocked) {
      if (queued) await io.skipIdea(queued.id, `Skipped: ${blocked}`);
      await io.log({ ...label, decision: "blocked", reason: `Skipped: ${blocked}` });
      exclude.push(topic.topic, topic.target_query);
      continue;
    }
    await io.progress(`Checking who ranks for "${topic.target_query}"`);
    const gate = await io.check(topic.target_query);
    if (gate.decision !== "skip") {
      await io.log({ ...label, decision: gate.decision, reason: gate.reason, gate });
      return { topic, queued, gate, overridden: false };
    }
    await io.log({ ...label, decision: "skip", reason: `Skipped: ${gate.reason}`, gate });
    if (queued) await io.skipIdea(queued.id, `Skipped: ${gate.reason}`);
    exclude.push(topic.topic, topic.target_query);
    const share = gate.strong / Math.max(1, gate.total);
    if (!weakest || share < weakest.share) weakest = { topic, queued, gate, overridden: true, share };
  }
  // A person's first free article is the sales moment: write the weakest of the candidates rather than nothing.
  if (isFree && weakest) {
    await io.log({ topic: weakest.topic.topic, query: weakest.topic.target_query, decision: "override", reason: `Free first article written anyway: ${weakest.gate!.reason}`, gate: weakest.gate! });
    return weakest;
  }
  return null;
}

// ---- the real Io, backed by the database ----

const db = () => sql();

export function dbIo(a: Pick<ArticleRow, "id" | "owner_id">, site: SiteRow, budget: Budget, progress: (note: string) => Promise<void>): Io {
  // The gate's searches get their own small budget: they must not eat the 6 searches the article needs for its sources.
  const gateBudget = new Budget({ ownerId: a.owner_id, siteId: site.id, articleId: a.id }, { usd: 0.4, tokens: 60_000, searches: MAX_TOPIC_TRIES + 2 });
  return {
    async nextQueued() {
      // Same order as before: the customer's own ideas, then rank loop topics (priority 10), then suggestions. Falls back if the rank loop migration is not applied.
      const [q] = await db()`select * from topic_ideas where site_id = ${site.id} and status = 'open' and kind in ('idea','suggested')
        order by (kind = 'idea') desc, priority desc, created_at limit 1`.catch(() => db()`select * from topic_ideas where site_id = ${site.id} and status = 'open' and kind in ('idea','suggested')
        order by (kind = 'idea') desc, created_at limit 1`);
      return (q as Queued) ?? null;
    },
    pick: (exclude, requested) => pickTopic(site, budget, exclude, requested),
    check: (query) => checkSerp(query, gateBudget),
    async skipIdea(id, why) {
      await db()`update topic_ideas set status = 'skipped', reason = left(coalesce(reason || ' ', '') || ${`[${why}]`}, 600) where id = ${id}`;
      // A rank loop opportunity that queued this topic shows the reason; it reopens by itself after 28 days.
      await db()`update seo_opportunities set status = 'fixed', action = ${why}, resolved_at = now() where topic_idea_id = ${id}`.catch(() => undefined);
    },
    async log(e) {
      await logGate({ ...e, siteId: site.id, articleId: a.id });
      if (e.decision === "skip" || e.decision === "blocked" || e.decision === "override")
        await db()`insert into insights (site_id, owner_id, article_id, kind, text) values (${site.id}, ${site.owner_id}, ${a.id}, 'note', ${`"${e.query}": ${e.reason}`})`;
    },
    skipped: () => recentlySkipped(site.id),
    progress,
  };
}
