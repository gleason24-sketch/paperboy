// SPDX-License-Identifier: AGPL-3.0-only
// The article engine: pick, research, write, check, fix once, check again, publish (or hold for review).
// One article runs start to finish inside a Netlify background function (15 minute limit).
import { appUrl } from "@/config/brand";
import { LIMITS } from "@/config/models";
import { AiNotConfigured, Budget, CapReached, Refused } from "@/lib/ai/client";
import { sql } from "@/lib/db";
import { trackEvent, stepSeconds, type StepTimes } from "@/lib/funnel";
import { kickArticle } from "@/lib/jobs";
import { button, layout, p, sendEmail } from "@/lib/email";
import { articleSchema, mdToHtml } from "@/lib/markdown";
import { fetchPage } from "@/lib/fetchpage";
import { pingIndexNow, publishArticle } from "@/lib/publish";
import { fixList, getVerifier, type Verdict } from "@/lib/quality";
import type { ArticleRow, SiteRow } from "@/lib/types";
import { escapeHtml, slugify } from "@/lib/util";
import type { Found } from "@/lib/ai/client";
import { findSources, readSources, type SourceDoc } from "./research";
import { chooseTopic, dbIo } from "./select";
import { FREE_TOPIC_TRIES } from "@/config/serp-gate";
import { logGate } from "./serp-gate";
import { suggestTopics, type TopicPick } from "./topics";
import { Draft, fixDraft, writeDraft, type DraftT } from "./write";

const db = () => sql();

async function step(id: string, status: ArticleRow["status"], note: string, extra: Record<string, unknown> = {}) {
  // step_times keeps the first time each stage started (existing keys win), so the funnel can show where a run spent its time.
  await db()`update articles set ${db()({ status, step_note: note, ...extra } as Record<string, any>)},
    step_times = ${db().json({ [status]: new Date().toISOString() } as never)}::jsonb || coalesce(step_times, '{}'::jsonb) where id = ${id}`;
}

async function loadSite(id: string): Promise<SiteRow> {
  const [s] = await db()`select * from sites where id = ${id}`;
  if (!s) throw new Error("Site not found");
  return s as SiteRow;
}

async function uniqueSlug(siteId: string, want: string, selfId: string, refreshOf: string | null): Promise<string> {
  if (refreshOf) {
    const [orig] = await db()`select slug from articles where id = ${refreshOf}`;
    if (orig?.slug) return orig.slug;
  }
  const base = slugify(want);
  const taken = new Set((await db()`select slug from articles where site_id = ${siteId} and id <> ${selfId} and slug like ${base + "%"}`).map((r) => r.slug));
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  return slug;
}

async function saveVerdict(a: ArticleRow, round: number, v: Verdict) {
  await db()`insert into quality_verdicts (article_id, site_id, owner_id, round, judge, score, pass, summary, checks)
    values (${a.id}, ${a.site_id}, ${a.owner_id}, ${round}, ${v.judge}, ${v.score}, ${v.pass}, ${v.summary}, ${db().json(v.checks as never)})`;
  await db()`update articles set quality_score = ${v.score}, quality_pass = ${v.pass} where id = ${a.id}`;
}

/** Claim the article so two workers never run it at once. Returns null if someone else holds it or it is finished. */
async function claim(articleId: string): Promise<ArticleRow | null> {
  const [a] = await db()`update articles set locked_until = now() + interval '16 minutes', attempts = attempts + 1
    where id = ${articleId} and status not in ('published', 'needs_review') and (locked_until is null or locked_until < now())
    returning *`;
  return (a as ArticleRow) ?? null;
}

export async function runArticle(articleId: string): Promise<void> {
  const a = await claim(articleId);
  if (!a) return;
  let retry = false;
  const site = await loadSite(a.site_id);
  const budget = new Budget(
    { ownerId: a.owner_id, siteId: a.site_id, articleId: a.id },
    undefined,
    { usd: Number(a.cost_usd), tokens: a.tokens_in + a.tokens_out, searches: a.searches },
  );
  try {
    // ---- 1. topic ----
    let topic: TopicPick;
    if (a.target_query && a.topic) {
      topic = { topic: a.topic, target_query: a.target_query, angle: a.angle ?? "", intent: (a.intent as TopicPick["intent"]) ?? "learning", signal: "research", reason: a.reason ?? "" };
    } else {
      // The customer's own ideas go first, then rank loop topics, then the topics already suggested to them, then a fresh pick.
      // Every candidate passes the blocklist and the SERP-strength gate (select.ts); a skipped one is replaced by the next in this same run.
      // A free first article is the sales moment and has a ten minute promise: two candidates, then write the weakest.
      const chosen = await chooseTopic(site, !!a.is_free, dbIo(a, site, budget, (note) => step(a.id, "picking", note)), a.is_free ? FREE_TOPIC_TRIES : undefined);
      if (!chosen) {
        await skipRound(a, site);
        return;
      }
      topic = chosen.topic;
      if (chosen.queued) await db()`update topic_ideas set status = 'used', article_id = ${a.id} where id = ${chosen.queued.id}`;
      await db()`update articles set topic = ${topic.topic}, target_query = ${topic.target_query}, angle = ${topic.angle}, intent = ${topic.intent}, reason = ${topic.reason} where id = ${a.id}`;
      await db()`insert into insights (site_id, owner_id, article_id, kind, text) values (${site.id}, ${site.owner_id}, ${a.id}, 'next_topic', ${topic.reason})`;
    }

    // ---- 2. research ----
    let sources: SourceDoc[] = (await db()`select url, title, text, selling, coalesce(selling_note,'') selling_note, '' summary, facts from article_sources where article_id = ${a.id}`) as unknown as SourceDoc[];
    if (sources.length < 2) {
      // Search results are saved first, so a retry after a crash reuses them instead of spending searches again.
      const saved = ((a as ArticleRow & { found_sources?: Found[] }).found_sources ?? []) as Found[];
      let found = saved;
      if (!found.length) {
        await step(a.id, "researching", "Searching the web for the best sources");
        found = await findSources(topic, site.domain, budget);
        if (!found.length) throw new Error("The web search found no usable sources for this topic.");
        await db()`update articles set found_sources = ${db().json(found as never)} where id = ${a.id}`;
      }
      await step(a.id, "researching", `Reading ${Math.min(found.length, LIMITS.maxSources)} sources and saving their text for the fact check`);
      sources = await readSources(found, topic, budget, (note) => step(a.id, "researching", note));
      if (sources.length < 2) throw new Error("Fewer than two sources could be opened and read, so the article was not written.");
      sources = [...sources, ...(await ownPages(site))];
      await db()`delete from article_sources where article_id = ${a.id}`;
      for (const s of sources)
        await db()`insert into article_sources (article_id, site_id, owner_id, url, title, text, selling, selling_note, facts)
          values (${a.id}, ${site.id}, ${site.owner_id}, ${s.url}, ${s.title}, ${s.text}, ${s.selling}, ${s.selling_note}, ${db().json(s.facts as never)})`;
      await db()`update articles set sources = ${db().json(sources.map((s) => ({ url: s.url, title: s.title, selling: s.selling })) as never)} where id = ${a.id}`;
    }

    // ---- 3. write ----
    await step(a.id, "writing", `Writing "${topic.topic}"`);
    let draft = await writeDraft(site, topic, sources, budget);
    await saveDraft(a.id, site, draft, a.refresh_of);

    // ---- 4. check, fix once, check again ----
    const qualityInput = (d: DraftT) => ({
      article: { title: d.title, bodyMarkdown: d.body_md, faq: d.faq },
      sources: sources.map((s) => ({ url: s.url, title: s.title, text: s.text, selling: s.selling })),
      voice: { description: site.voice?.description || site.scan.tone, interview: site.voice?.interview, wordsToAvoid: site.words_to_avoid },
      bannedClaims: site.banned_claims,
      ownHosts: [site.domain, site.blog_host ?? ""].filter(Boolean),
    });
    const verifier = getVerifier(budget);
    await step(a.id, "checking", "Checking every claim, number and citation against the saved sources");
    let verdict = await verifier.verify(qualityInput(draft));
    await saveVerdict(a, 1, verdict);
    if (!verdict.pass) {
      await step(a.id, "fixing", `Fixing ${verdict.checks.flatMap((c) => c.issues).filter((i) => i.severity === "block").length} issues the fact check found`);
      // Surgical fix of the flagged paragraphs only; a full rewrite only if none of them can be located.
      const blocking = verdict.checks.flatMap((c) => c.issues).filter((i) => i.severity === "block");
      draft = (await fixDraft(site, topic, sources, draft, blocking, budget)) ?? (await writeDraft(site, topic, sources, budget, { previous: draft, issues: fixList(verdict) }));
      await saveDraft(a.id, site, draft, a.refresh_of);
      await step(a.id, "checking", "Checking the fixed version");
      verdict = await verifier.verify(qualityInput(draft));
      await saveVerdict(a, 2, verdict);
    }
    if (!verdict.pass) {
      await hold(a.id, "quality", `The fact check still found problems after one rewrite: ${verdict.summary} Open the article to see each one.`);
      if (a.is_free) await finishedFree(a.id, site, false);
      await notifyReview(site, a.id, "quality");
      return;
    }

    if (a.is_free) await trackEvent({ event: "fact_check_passed", userId: a.owner_id, siteId: site.id, articleId: a.id, props: { score: verdict.score }, dedupeKey: `fact_check_passed:${a.id}` });

    // ---- 5. publish, or wait for approval ----
    // The free first article always waits for the person's OK: the result page and the email both have a "Publish it" button,
    // and nothing goes onto their domain before they have read it.
    if (a.is_free && !a.refresh_of) {
      await hold(a.id, "approval", "Passed the fact check. Read it, then press Publish it.");
      await finishedFree(a.id, site, true);
      await refillSuggestions(site, 5).catch((e) => console.error("topic suggestions failed", e));
      return;
    }
    if (site.approval_mode === "approve") {
      await hold(a.id, "approval", "Passed the fact check. Waiting for your approval to publish.");
      await notifyReview(site, a.id, "approval");
      return;
    }
    await finalizePublish(a.id);
  } catch (e) {
    retry = await handleFailure(a, e);
  } finally {
    await db()`update articles set locked_until = null where id = ${a.id}`;
  }
  // The first failure is retried at once in a fresh run. Waiting for the hourly scheduler would blow the ten minute promise.
  if (retry) await kickArticle(a.id).catch((e) => console.error("retry kick failed", e));
}

/** Free first article is ready to read (or held for review): one funnel event with the time it took. */
async function finishedFree(articleId: string, site: SiteRow, passed: boolean) {
  const [r] = await db()`select a.created_at, a.step_times, a.quality_score, a.cost_usd,
      (select max(sc.created_at) from scans sc where sc.domain = s.domain and sc.created_at <= s.created_at) pasted_at
    from articles a join sites s on s.id = a.site_id where a.id = ${articleId}`;
  if (!r) return;
  const now = new Date();
  const secs = (from: unknown) => (from ? Math.max(0, Math.round((now.getTime() - new Date(from as string).getTime()) / 1000)) : undefined);
  await trackEvent({
    event: "article_finished", userId: site.owner_id, siteId: site.id, articleId, dedupeKey: `article_finished:${articleId}`,
    props: {
      passed, score: r.quality_score, cost_usd: Number(r.cost_usd),
      secs_pipeline: secs(r.created_at), secs_since_paste: secs(r.pasted_at),
      step_secs: stepSeconds(r.step_times as StepTimes, now),
    },
  });
}

/**
 * Every candidate this round was skipped (SERP too strong, or blocked). Nothing was written, so the empty placeholder is removed:
 * the weekly quota only counts real articles, and the hourly scheduler leaves the site alone for a few hours (serp_gate_log).
 */
async function skipRound(a: ArticleRow, site: SiteRow) {
  const why = "No article this round: every topic candidate was skipped because the Google results for it are held by strong domains. The reasons are listed in Insights. A different topic is tried later.";
  await logGate({ siteId: site.id, articleId: null, query: "(all candidates)", decision: "exhausted", reason: why });
  await db()`insert into insights (site_id, owner_id, article_id, kind, text) values (${site.id}, ${site.owner_id}, null, 'note', ${why})`;
  await db()`delete from articles where id = ${a.id} and topic is null and status in ('planned','picking') and kind = 'new'`;
}

/**
 * The customer's own pricing or product page, saved like any source, so claims about their own price and offer can be
 * cited and checked against what their site actually says.
 */
async function ownPages(site: SiteRow): Promise<SourceDoc[]> {
  const pages = (site.scan.link_pages ?? []).filter((p) => /pric|plan|product|service|feature|offer/i.test(`${p.url} ${p.title}`)).slice(0, 2);
  const urls = [site.url, ...pages.map((p) => p.url).filter((u) => u.replace(/\/$/, "") !== site.url.replace(/\/$/, ""))];
  // What the customer confirmed about themselves during setup counts as their own words.
  const profile = [site.scan.what_you_do, site.scan.who_you_serve, site.scan.offer, site.voice?.interview?.map((x) => x.a).join("\n")].filter(Boolean).join("\n");
  const out: SourceDoc[] = [];
  for (const [i, u] of urls.entries()) {
    const p = await fetchPage(u, 12_000).catch(() => null);
    const text = `${p?.text.slice(0, 12_000) ?? ""}${i === 0 && profile ? `\n\nWHAT ${site.scan.name || site.domain} SAYS ABOUT ITSELF:\n${profile}` : ""}`;
    if (text.trim().length > 200)
      out.push({
        url: p?.finalUrl ?? u, title: `${site.scan.name || site.domain}: ${p?.title || "home page"}`, text, selling: false, selling_note: "",
        summary: "The customer's own page. Use it for facts about their own business, product, price and offer.",
        facts: [],
      });
  }
  return out;
}

async function saveDraft(id: string, site: SiteRow, d: DraftT, refreshOf: string | null) {
  const parsed = Draft.parse(d);
  const slug = await uniqueSlug(site.id, parsed.slug || parsed.title, id, refreshOf);
  const internal = [...parsed.body_md.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]).filter((u) => u.includes(site.domain));
  await db()`update articles set title = ${parsed.title}, slug = ${slug}, meta_title = ${parsed.meta_title.slice(0, 70)},
    meta_description = ${parsed.meta_description.slice(0, 170)}, excerpt = ${parsed.excerpt}, body_md = ${parsed.body_md},
    body_html = ${mdToHtml(parsed.body_md, site.domain)}, faq = ${db().json(parsed.faq as never)},
    internal_links = ${db().json([...new Set(internal)] as never)},
    cta_text = ${site.cta_text || site.scan.cta_text || null}, cta_url = ${site.cta_url || site.scan.cta_url || site.url}
    where id = ${id}`;
}

async function hold(id: string, reason: ArticleRow["review_reason"], note: string) {
  await db()`update articles set status = 'needs_review', review_reason = ${reason}, review_note = ${note}, step_note = null, seen_at = null where id = ${id}`;
}

/** Returns true when the article should be started again right away. */
async function handleFailure(a: ArticleRow, e: unknown): Promise<boolean> {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`article ${a.id} failed`, e);
  if (e instanceof CapReached) {
    await hold(a.id, "cost_cap", `${msg} Nothing was published. You can publish what was written after reading it, or delete it.`);
    return false;
  }
  if (e instanceof Refused) {
    await hold(a.id, "error", `${msg} Pick a different topic or edit the topic and try again.`);
    return false;
  }
  if (e instanceof AiNotConfigured) {
    await db()`update articles set status = 'failed', step_note = null, review_reason = 'error', review_note = ${msg}, seen_at = null where id = ${a.id}`;
    return false;
  }
  // One automatic retry by the scheduler, then it waits for the customer.
  const final = a.attempts >= 2;
  await db()`update articles set status = ${final ? "failed" : "planned"}, step_note = null, review_reason = 'error',
    review_note = ${final ? `This article could not be finished: ${msg} Press "Try again" to restart it.` : `Retrying after an error: ${msg}`}, locked_until = null where id = ${a.id}`;
  return !final;
}

/** Publishes an article that passed the fact check (autopilot, or the customer pressed Approve). */
export async function finalizePublish(articleId: string): Promise<{ ok: boolean; message: string }> {
  const [a] = (await db()`update articles set status = 'publishing', step_note = 'Publishing to your site' where id = ${articleId}
    and (status in ('checking','fixing','writing','publishing') or (status = 'needs_review' and review_reason in ('approval','publish_error','quality','cost_cap')))
    returning *`) as unknown as ArticleRow[];
  if (!a) return { ok: false, message: "This article is not ready to publish." };
  const site = await loadSite(a.site_id);
  try {
    const now = new Date().toISOString();
    let orig: ArticleRow | null = null;
    if (a.refresh_of) [orig] = (await db()`select * from articles where id = ${a.refresh_of}`) as unknown as ArticleRow[];
    const predicted = orig?.published_url || (site.publish_method === "hosted" || site.publish_method === "prompt" ? (await import("@/lib/publish")).articleUrl(site, a.slug!) : "");
    const schema = articleSchema({
      title: a.title!, description: a.meta_description ?? a.excerpt ?? "", url: predicted || site.url, publishedAt: orig?.published_at ?? now, updatedAt: now,
      publisherName: site.scan.name || site.name || site.domain, publisherUrl: site.url, logoUrl: site.scan.logo_url, faq: a.faq ?? [],
    });
    a.schema_ld = schema;
    const result = await publishArticle(site, a, orig ? { externalId: orig.external_id, url: orig.published_url } : undefined);
    const url = result.url || predicted;
    if (orig) {
      // A refresh replaces the original article's content at the same address.
      await db()`update articles set title = ${a.title}, meta_title = ${a.meta_title}, meta_description = ${a.meta_description}, excerpt = ${a.excerpt},
        body_md = ${a.body_md}, body_html = ${a.body_html}, faq = ${db().json(a.faq as never)}, schema_ld = ${db().json(schema as never)},
        sources = ${db().json(a.sources as never)}, quality_score = ${a.quality_score}, updated_content_at = now() where id = ${orig.id}`;
    }
    await db()`update articles set status = 'published', step_note = null, review_reason = null, review_note = null, seen_at = null,
      published_url = ${url}, external_id = ${result.externalId ?? null}, published_at = ${now}, schema_ld = ${db().json(schema as never)} where id = ${a.id}`;
    const indexed = await pingIndexNow(site, url);
    await db()`insert into insights (site_id, owner_id, article_id, kind, text) values (${site.id}, ${site.owner_id}, ${a.id}, 'note',
      ${`${orig ? "Refreshed" : "Published"} "${a.title}". ${indexed}`})`;
    if (!orig) await refillSuggestions(site).catch((e) => console.error("topic suggestions failed", e));
    if (!orig) await notifyLive(site, a, url).catch((e) => console.error("article-live email failed", e));
    return { ok: true, message: "Published." };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await hold(a.id, "publish_error", `Publishing failed: ${msg}`);
    await notifyReview(site, a.id, "publish_error");
    return { ok: false, message: msg };
  }
}

/** Keeps three suggested topics queued per site, so the customer always sees what comes next (one cheap call). */
export async function refillSuggestions(site: SiteRow, want = 3) {
  const [{ n }] = await db()`select count(*)::int n from topic_ideas where site_id = ${site.id} and status = 'open' and kind = 'suggested'`;
  if (n >= want) return;
  const budget = new Budget({ ownerId: site.owner_id, siteId: site.id, articleId: null }, { usd: 0.25, tokens: 60_000, searches: 0 });
  // Suggestions that overlap existing articles are dropped, so ask a second time if the first round came up short.
  let missing = want - n;
  for (let round = 0; round < 2 && missing > 0; round++) {
    for (const t of await suggestTopics(site, budget, missing)) {
      await db()`insert into topic_ideas (site_id, owner_id, kind, text, target_query, angle, intent, reason)
        values (${site.id}, ${site.owner_id}, 'suggested', ${t.topic}, ${t.target_query}, ${t.angle}, ${t.intent}, ${t.reason})`;
      missing--;
    }
  }
}

/** Every new article on a paid plan: a short email with the link (switch off in Account). */
async function notifyLive(site: SiteRow, a: ArticleRow, url: string) {
  const [row] = await db()`select email, notify_published from profiles where id = ${a.owner_id}`;
  if (!row?.email || row.notify_published === false) return;
  const view = appUrl(`/app/sites/${site.id}/articles/${a.id}`);
  const title = `New article live on ${site.domain}`;
  const body =
    p(`"${escapeHtml(a.title ?? "Your article")}" is published${a.quality_score != null ? ` and passed the fact check with ${a.quality_score} of 100` : ""}.`) +
    (a.reason ? p(`<strong>Why this topic:</strong> ${escapeHtml(a.reason)}`) : "") +
    p(button(url || view, "Read it live")) +
    p(`<a href="${view}">See its sources and fact check</a> · <a href="${appUrl("/app/account")}">Stop these emails</a>`);
  await sendEmail(row.email, title, layout(title, body), `${title}\n\n${url || view}`);
}

async function notifyReview(site: SiteRow, articleId: string, why: "approval" | "quality" | "publish_error") {
  const [row] = await db()`select a.title, a.approval_token, p.email from articles a join profiles p on p.id = a.owner_id where a.id = ${articleId}`;
  if (!row?.email) return;
  const view = appUrl(`/app/sites/${site.id}/articles/${articleId}`);
  const approve = appUrl(`/approve/${row.approval_token}`);
  const title = why === "approval" ? "An article is ready for your OK" : why === "quality" ? "An article needs your review" : "An article could not be published";
  const body =
    why === "approval"
      ? p(`"${escapeHtml(row.title ?? "Your article")}" passed the fact check and is ready for ${escapeHtml(site.domain)}.`) + p(button(approve, "Approve and publish")) + p(`<a href="${view}">Read it first</a>`)
      : why === "quality"
        ? p(`"${escapeHtml(row.title ?? "Your article")}" did not pass the fact check after one rewrite, so it was not published.`) + p(button(view, "See what to fix"))
        : p(`"${escapeHtml(row.title ?? "Your article")}" passed the fact check, but your site did not accept it.`) + p(button(view, "See the error"));
  await sendEmail(row.email, title, layout(title, body), `${title}\n\n${view}`);
}
