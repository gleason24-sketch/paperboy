// Step 3: write (and the one rewrite after a failed quality check), on the writer model in src/config/models.ts.
import { z } from "zod";
import { MODELS } from "@/config/models";
import { structured, type Budget } from "@/lib/ai/client";
import type { SiteRow } from "@/lib/types";
import { ownSiteId } from "@/lib/own-blog";
import { titleStyles } from "@/lib/rankloop/styles";
import { noDashesDeep } from "@/lib/util";
import type { SourceDoc } from "./research";
import type { TopicPick } from "./topics";

export const Draft = z.object({
  title: z.string().describe("The H1. Plain and specific, ideally phrased like the search. Under 70 characters."),
  slug: z.string().describe("Short, lowercase, hyphenated, keyword first"),
  meta_title: z.string().describe("Title tag, at most 60 characters"),
  meta_description: z.string().describe("140 to 155 characters, answers the search and gives a reason to click"),
  excerpt: z.string().describe("One or two sentences for listings"),
  body_md: z.string().describe("The article body in Markdown, without the H1 and without the FAQ"),
  faq: z.array(z.object({ q: z.string(), a: z.string() })).describe("3 to 6 real follow-up questions with 1 to 3 sentence answers"),
});
export type DraftT = z.infer<typeof Draft>;

export const HOUSE_STYLE = `House style (non-negotiable):
- Answer the question in the first paragraph, in two or three sentences. No preamble, no "In this article".
- Plain, short sentences. Vary the length a little. No hype, no stacked adjectives, no filler, no "in today's world", no "delve", no "game changer", no "not only X but also Y".
- Every factual claim about the outside world (numbers, prices, dates, rules, what a company or law does) links inline to its source, in the same sentence or the same paragraph. Write the link target as the source's tag, not its URL: [Wishup's 2026 price list](S3). Tags are replaced with the exact URLs after writing. Use the tag of the source whose facts list contains that exact fact; never put a fact from one source behind another source's tag, and never combine facts from two sources behind one tag. Use a number only if it appears in that source's facts or quotes, exactly as written there, and link the source that has it (not a different one). This includes the opening answer and any summary or table.
- When you calculate a number from sourced figures, show the arithmetic in the same sentence ("$1,500 plus 12 times $297 comes to $5,064") so readers can check it, and cite the figures where they first appear. This covers every number you work out: totals, differences, savings, break-even months, percentages. Never state a calculated number on its own ("Riot is $306 ahead", "about 29 months"); write the sum that produces it ("$1,500 divided by the $53 monthly difference is about 28.3, so about 29 months"). Table cells too: "12 times $297 is $3,564", not "$3,564".
- Never invent numbers for examples, price tiers or scenarios. If you need an illustration with numbers, say plainly that it is a made-up example ("Here is a made-up example, not real data.").
- When a source sells something related, say so in the same paragraph ("That company sells removal services, so confirm the steps on Google's own page.").
- Label opinions as opinions: "My take:", "In my view", "This is my judgment, not a sourced fact." Use the owner's own answers for opinions and experience; never invent experience, customers, results or people. (Paperboy's own blog is the exception: see its voice rule in the customer block.)
- Competitor prices and features may only come from the competitor's own domain (its pricing, features or integrations pages), cited with the access date, for example "prices as of Oct 2026, from the company's site". Never take a competitor's prices or features from third-party review, roundup or comparison sites, even when a source lists them; if the competitor's own pages do not show a fact, leave it out or say it is not listed there.
- Alternatives and comparison articles: source each competitor from that competitor's own domain only. Another company's "X vs Y" or alternatives page is never a source for a third company's facts. Do not mention refunds or money-back guarantees, including a competitor's. Do not make "only" or "the only tool that" claims. Date every competitor price: "checked <Month D, YYYY>" with the day you read the page.
- Made-up examples must say they are made up ("Here is a made-up example, not real data.").
- Use a table, a checklist or numbered steps wherever they make the answer easier to scan. A short "quick version" section near the top helps busy readers.
- Never use em dashes or en dashes as punctuation. Use periods, commas or colons.
- Sentence case for headings. H2 and H3 only.
- 1,000 to 1,800 words in the body.
- Before you answer, check every sentence that has a number, a price or a named company: the number must appear in the facts of the source you tagged, and the customer's own prices may only be tagged with the customer's own page. Fix or delete any sentence that fails.`;

function sourcesBlock(sources: SourceDoc[]) {
  return sources
    .map((s, i) => `SOURCE S${i + 1}: ${s.url}
Title: ${s.title}
${s.selling ? `SELLS SOMETHING: ${s.selling_note || "yes"} (disclose this when you cite it)` : "Not selling anything related."}
Summary: ${s.summary}
Facts (with exact quotes):
${s.facts.map((f) => `- ${f.claim} | quote: "${f.quote}"`).join("\n") || "- none extracted"}`)
    .join("\n\n");
}

/** True for the operator's own marketing site row (OWN_SITE_ID). Always false on a plain self-host. */
export const isOwnSite = (site: Pick<SiteRow, "id">) => site.id === ownSiteId();

export function siteBlock(site: SiteRow) {
  const s = site.scan;
  const interview = site.voice?.interview ?? [];
  return `THE CUSTOMER
Site: ${site.url} (${s.name ?? site.name})
What they do: ${s.what_you_do ?? ""}
Who they serve: ${s.who_you_serve ?? ""}
Voice: ${site.voice?.description || s.tone || "plain, direct, helpful"}
${interview.length ? `The owner's own answers (use these for opinions and first-hand experience):\n${interview.map((x) => `Q: ${x.q}\nA: ${x.a}`).join("\n")}` : "No owner interview yet: do not write first-hand experience; write from the sources and label any judgment as an opinion."}
Never claim: ${site.banned_claims.length ? site.banned_claims.join("; ") : "nothing listed"}
Words to avoid: ${site.words_to_avoid.length ? site.words_to_avoid.join(", ") : "none listed"}

INTERNAL PAGES YOU MAY LINK TO (use these exact URLs, not tags; link 2 to 4 where they genuinely help). Facts about the customer's own prices or offer may only come from the customer's pages given in the research as sources (tagged like any other source):
${(s.link_pages ?? []).map((p) => `${p.url} | ${p.title}`).join("\n") || site.url}

${`CALL TO ACTION: exactly one, near the end, a Markdown link with the text "${site.cta_text || s.cta_text || `Visit ${s.name ?? site.name}`}" pointing at ${site.cta_url || s.cta_url || site.url}. Lead into it naturally from the article's point; one or two sentences, no hard sell.`}`;
}

export async function writeDraft(site: SiteRow, topic: TopicPick, sources: SourceDoc[], budget: Budget, fix?: { previous: DraftT; issues: string }): Promise<DraftT> {
  return writeDraftOnce(site, topic, sources, budget, fix);
}

async function writeDraftOnce(site: SiteRow, topic: TopicPick, sources: SourceDoc[], budget: Budget, fix?: { previous: DraftT; issues: string }): Promise<DraftT> {
  const styles = await titleStyles(site.id); // title styles measured on this site (rank loop); empty until there are results
  const out = await structured({
    model: MODELS.writer,
    purpose: fix ? "rewrite" : "write",
    budget,
    maxTokens: 32000,
    effort: "high",
    schema: Draft,
    system: `You are a careful, experienced writer for a small company's website. You write the article a reader would trust: it answers the search, shows its sources, admits what is opinion, and is easy to scan. Search engines and AI assistants should be able to quote your first paragraph as the answer.

${HOUSE_STYLE}`,
    prompt: `${fix ? "REWRITE the article below to fix every issue the fact check found. Keep everything that works. For each \"must fix\" issue: if the sources support a corrected version, write that and link the source that says it; if they do not, delete the sentence. Never rephrase an unsupported claim into a vaguer one, and do not add new facts that are not in the sources." : "Write the article."}

Today's date: ${new Date().toISOString().slice(0, 10)}. Never put a past year in the title; only use a year when the sources are about it.
Target search: "${topic.target_query}"
Working title: ${topic.topic}
Angle: ${topic.angle}
Reader intent: ${topic.intent}
${styles ? `\n${styles}Use these only to shape the title tag (meta_title) and meta description.\n` : ""}
${siteBlock(site)}

RESEARCH (the only facts you may use; link each to its URL):
${sourcesBlock(sources)}
${fix ? `\nFACT CHECK ISSUES TO FIX:\n${fix.issues}\n\nPREVIOUS VERSION:\nTitle: ${fix.previous.title}\n\n${fix.previous.body_md}\n\nFAQ:\n${fix.previous.faq.map((f) => `Q: ${f.q}\nA: ${f.a}`).join("\n")}` : ""}`,
  });
  return linkTags(noDashesDeep(out), sources);
}

/** Replaces [text](S3) source tags with the exact source URLs. Unknown tags lose the link but keep the text. */
export function linkTags(d: DraftT, sources: { url: string }[]): DraftT {
  const fix = (md: string) =>
    md
      .replace(/\[([^\]]+)\]\(\s*\[?S(\d+)\]?\s*\)/gi, (_m, text, n) => {
        const src = sources[Number(n) - 1];
        return src ? `[${text}](${src.url})` : text;
      })
      .replace(/\s?\[S\d+\](?!\()/gi, ""); // stray bare tags
  return { ...d, body_md: fix(d.body_md), faq: d.faq.map((f) => ({ q: f.q, a: fix(f.a) })) };
}


// ---------- the one fix: surgical, paragraph by paragraph ----------

const Fixes = z.object({
  paragraphs: z.array(z.object({
    id: z.string().describe("The paragraph id, e.g. P2"),
    text: z.string().describe("The corrected paragraph in Markdown, or an empty string to delete it"),
  })),
});

type BlockIssue = { quote: string; problem: string; fix: string; sourceUrl?: string };

const plain = (md: string) => md.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`>#|]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Fixes only the paragraphs that carry blocking issues and leaves every other word as it was, so the fix cannot bring
 * new problems into parts of the article that already passed. Returns null when no flagged paragraph can be found
 * (the caller then falls back to a full rewrite).
 */
/**
 * When one cell of a table fails for a missing link, its sibling rows usually share the problem (the next plan's price,
 * the next competitor), and fixing only the flagged row makes the second check fail on the others. Returns the other
 * rows of that table, each with the issue to fix, so the whole table is corrected in one pass.
 */
export function tableSiblings(units: { text: string; where: string; bi: number }[], hit: Map<number, BlockIssue[]>): Map<number, BlockIssue[]> {
  const out = new Map<number, BlockIssue[]>();
  for (const [idx, issues] of hit) {
    const u = units[idx];
    const noLink = issues.filter((i) => /no source link/i.test(i.problem));
    if (u.where !== "body" || !/^\s*\|/.test(u.text) || !noLink.length) continue;
    units.forEach((v, j) => {
      if (j === idx || hit.has(j) || v.where !== "body" || v.bi !== u.bi || !/^\s*\|/.test(v.text) || /^\s*\|?\s*:?-{3,}/.test(v.text)) return;
      out.set(j, [{ quote: noLink[0].quote, problem: "Another row of this table has a number with no source link, and this row may have the same problem. Check every number in this row.", fix: "Link the source that gives each number in this row, exactly as the first row was fixed. Change nothing else.", sourceUrl: noLink[0].sourceUrl }]);
    });
  }
  return out;
}

export async function fixDraft(site: SiteRow, topic: TopicPick, sources: SourceDoc[], draft: DraftT, issues: BlockIssue[], budget: Budget): Promise<DraftT | null> {
  const blocks = draft.body_md.split(/\n{2,}/);
  // Table rows and list items are fixed one line at a time.
  const units: { id: string; text: string; where: "body" | "faq"; bi: number; li: number }[] = [];
  blocks.forEach((b, bi) => {
    const lines = b.split("\n");
    const lineWise = lines.length > 1 && lines.every((l) => /^\s*(\||[-*+] |\d+\. )/.test(l) || !l.trim());
    if (lineWise) lines.forEach((l, li) => units.push({ id: "", text: l, where: "body", bi, li }));
    else units.push({ id: "", text: b, where: "body", bi, li: -1 });
  });
  draft.faq.forEach((f, i) => units.push({ id: "", text: f.a, where: "faq", bi: i, li: -1 }));
  const hit = new Map<number, BlockIssue[]>();
  for (const iss of issues) {
    const q = plain(iss.quote.replace(/…$/, "")).slice(0, 50);
    if (q.length < 12) continue;
    const idx = units.findIndex((u) => plain(u.text).includes(q));
    if (idx >= 0) hit.set(idx, [...(hit.get(idx) ?? []), iss]);
  }
  if (!hit.size) return null;
  for (const [idx, extra] of tableSiblings(units, hit)) hit.set(idx, [...(hit.get(idx) ?? []), ...extra]);
  const targets = [...hit.keys()].sort((a, b) => a - b).map((idx, n) => ({ ...units[idx], idx, id: `P${n + 1}` }));
  const out = await structured({
    model: MODELS.writer,
    purpose: "fix",
    budget,
    maxTokens: 16000,
    effort: "high",
    schema: Fixes,
    system: `You correct specific paragraphs of an article after a fact check. Change only what the issues require. Keep the voice, the formatting (a table row stays a table row with the same columns, a list item stays a list item) and every correct link. For each issue: if a source below supports a corrected version, write it and link that source with its tag, like [text](S2); if not, remove the claim, or return an empty string to delete the whole paragraph when nothing is left.

${HOUSE_STYLE}`,
    prompt: `Article: "${draft.title}" (target search "${topic.target_query}")

PARAGRAPHS TO FIX:
${targets.map((t) => `${t.id}:\n${t.text}\nISSUES:\n${hit.get(t.idx)!.map((i) => `- ${i.problem} Fix: ${i.fix}${i.sourceUrl ? ` (source: ${i.sourceUrl})` : ""}`).join("\n")}`).join("\n\n")}

RESEARCH (the only facts you may use):
${sourcesBlock(sources)}

THE CUSTOMER: ${site.scan.name ?? site.name}, ${site.url}

Return every paragraph id above with its corrected text.`,
  });
  const fixed = new Map(out.paragraphs.map((p) => [p.id, noDashesDeep(p.text)]));
  const body = blocks.map((b) => b.split("\n"));
  const faq = draft.faq.map((f) => ({ ...f }));
  for (const t of targets) {
    const next = fixed.get(t.id);
    if (next === undefined) continue;
    if (t.where === "faq") faq[t.bi].a = next;
    else if (t.li >= 0) body[t.bi][t.li] = next;
    else body[t.bi] = [next];
  }
  const body_md = body.map((ls) => ls.filter((l, i, arr) => l !== "" || arr.length === 1).join("\n")).filter((b) => b.trim()).join("\n\n");
  return linkTags({ ...draft, body_md, faq: faq.filter((f) => f.a.trim()) }, sources);
}
