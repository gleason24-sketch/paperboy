// SPDX-License-Identifier: AGPL-3.0-only
// The open fact check. One entry point: checkArticle(input, judge) -> Verdict.
//
// Every check compares the article with the saved source text. Rule-based checks run first (numbers must appear in the
// cited source, links must point at sources that were actually read, banned phrases, house style). A Judge then reads
// each cited sentence next to the passages of its source most likely to support it. The Judge is pluggable: the open
// RuleJudge needs no model at all, FastModelJudge uses your own Anthropic key, and the hosted verifier (see verifier.ts)
// is the optional premium option. Nothing passes because it "sounds right".
import { z } from "zod";
import { bestPassages, CALC, findNumbers, HYPE, hostOf, MADE_UP, numberInText, OPINION, sameUrl, sentences, type Sentence } from "./text";
import type { CheckResult, Issue, Judge, QualityInput, QualitySource, Verdict } from "./types";

export type { CheckResult, Issue, Judge, QualityInput, QualitySource, Verdict } from "./types";
export { sentences, numberInText, findNumbers, bestPassages } from "./text";

export const PASS_SCORE = 70;

const LABELS: Record<CheckResult["id"], string> = {
  unsourced_claims: "Every claim has a source",
  made_up_stats: "Numbers match their sources",
  citation_mismatch: "Sources say what the article says",
  voice_drift: "Sounds like the customer",
  banned_claims: "No banned claims",
  house_style: "House style",
};

const clip = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function findSource(url: string, sources: QualitySource[]) {
  return sources.find((s) => sameUrl(s.url, url));
}

// ---------- rule-based checks ----------

const normNum = (n: string) => n.replace(/[$€£,\s]/g, "").replace(/percent|per cent/i, "%").toLowerCase();

/** Figures already verified somewhere in the article (in a sentence linked to a source that contains them, or in a
 *  shown calculation). They do not need a second link when repeated, for example in a summary table or the FAQ. */
function verifiedNumbers(input: QualityInput, list: Sentence[]): Set<string> {
  const verified = new Set<string>();
  for (const s of list) {
    if (CALC.test(s.text)) s.numbers.forEach((n) => verified.add(normNum(n)));
    const text = s.links.map((u) => findSource(u, input.sources)?.text ?? "").join("\n");
    for (const n of s.numbers) if (text && numberInText(n, text)) verified.add(normNum(n));
  }
  return verified;
}

export function ruleChecks(input: QualityInput, list: Sentence[]) {
  const own = new Set((input.ownHosts ?? []).map((h) => h.replace(/^www\./, "").toLowerCase()));
  const isOwn = (u: string) => own.has(hostOf(u));
  const stats: Issue[] = [];
  const unsourced: Issue[] = [];
  const badLinks: Issue[] = [];
  const style: Issue[] = [];
  const banned: Issue[] = [];

  const verified = verifiedNumbers(input, list);

  for (const s of list) {
    // Links to the customer's own site are not citations, unless we read that page as a source (their pricing page
    // is the right source for their own price).
    const ext = s.links.filter((u) => !isOwn(u) || findSource(u, input.sources));
    const knownLinks = ext.filter((u) => findSource(u, input.sources));
    for (const u of ext.filter((x) => !isOwn(x) && !findSource(x, input.sources)))
      badLinks.push({ quote: clip(s.text), problem: `Links to ${u}, which was not one of the sources read for this article.`, fix: "Link to one of the researched sources, or remove the claim.", severity: "block", sourceUrl: u });

    // A shown calculation is checked through its inputs, which are cited where they first appear.
    if (s.numbers.length && !s.isExample && !CALC.test(s.text)) {
      // A link elsewhere in the same paragraph counts, but only if that source really contains the number.
      // A table row or list item also rests on the link in the sentence that introduces its table or list.
      const paraLinks = knownLinks.length ? knownLinks : [...new Set([...list.filter((x) => x.para === s.para).flatMap((x) => x.links), ...s.leadLinks])].filter((u) => findSource(u, input.sources));
      const paraText = paraLinks.map((u) => findSource(u, input.sources)!.text).join("\n");
      if (!knownLinks.length && paraLinks.length && s.numbers.every((n) => numberInText(n, paraText))) {
        // sourced by its paragraph
      } else if (!knownLinks.length && s.numbers.every((n) => verified.has(normNum(n)))) {
        // already cited or calculated elsewhere in the article
      } else if (!knownLinks.length) {
        if (!s.isOpinion) stats.push({ quote: clip(s.text), problem: `The number${s.numbers.length > 1 ? "s" : ""} ${s.numbers.join(", ")} ${s.numbers.length > 1 ? "have" : "has"} no source link.`, fix: "If you calculated it, write the arithmetic in the sentence (\"$1,500 divided by $53 a month is about 29 months\"). Otherwise link the source that gives this number, label it as an example, or remove it.", severity: "block" });
      } else {
        const text = knownLinks.map((u) => findSource(u, input.sources)!.text).join("\n");
        const missing = s.numbers.filter((n) => !numberInText(n, text));
        if (missing.length)
          stats.push({ quote: clip(s.text), problem: `${missing.join(", ")} does not appear in the linked source.`, fix: "Use the figure exactly as the source gives it. If you calculated it from the source, write the arithmetic in the sentence. Otherwise remove it.", severity: "block", sourceUrl: knownLinks[0] });
      }
    } else if (s.factSignal && !ext.length && !s.isExample && !s.isOpinion && s.links.length === 0) {
      unsourced.push({ quote: clip(s.text), problem: "Reads as a factual claim but has no source link.", fix: "Add a link to the source, or rephrase it as an opinion and say so.", severity: "warn" });
    }
  }

  // Sources that sell something must be disclosed near where they are cited.
  for (const src of input.sources.filter((x) => x.selling)) {
    const citing = list.filter((s) => s.links.some((u) => sameUrl(u, src.url)));
    if (!citing.length) continue;
    const near = list.filter((s) => citing.some((c) => c.section === s.section)).map((s) => s.text).join(" ");
    if (!/\b(sells?|selling|vendor|makes?|offers?|commercial|affiliate|sponsor|its own product|their product|company that)\b/i.test(near))
      style.push({ quote: clip(citing[0].text), problem: `${hostOf(src.url)} sells something related, and the article does not say so.`, fix: "Add a short note that this source sells a related product or service.", severity: "block", sourceUrl: src.url });
  }

  const all = `${input.article.title}\n${input.article.bodyMarkdown}\n${(input.article.faq ?? []).map((f) => `${f.q} ${f.a}`).join("\n")}`;
  if (/—/.test(all)) style.push({ quote: clip(all.slice(Math.max(0, all.indexOf("—") - 60), all.indexOf("—") + 60)), problem: "Contains an em dash.", fix: "Use a period, comma or colon.", severity: "block" });
  for (const re of HYPE) {
    const m = all.match(re);
    if (m) style.push({ quote: m[0], problem: "Hype or machine-sounding phrase.", fix: "Say it plainly and specifically.", severity: "warn" });
  }
  for (const w of input.voice?.wordsToAvoid ?? []) {
    if (w.trim().length > 1 && new RegExp(`\\b${w.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(all))
      style.push({ quote: w, problem: `Uses "${w}", which is on the customer's list of words to avoid.`, fix: "Use a different word.", severity: "block" });
  }
  const body = input.article.bodyMarkdown.toLowerCase().replace(/\s+/g, " ");
  for (const claim of input.bannedClaims ?? []) {
    const c = claim.toLowerCase().trim();
    if (c.length > 3 && body.includes(c)) banned.push({ quote: claim, problem: "Makes a claim the customer banned.", fix: "Remove the claim.", severity: "block" });
  }
  const firstPara = input.article.bodyMarkdown.trim().split(/\n\s*\n/)[0] ?? "";
  if (/^#/.test(firstPara.trim())) style.push({ quote: clip(firstPara), problem: "Opens with a heading instead of the answer.", fix: "Start with a paragraph that answers the question.", severity: "warn" });
  if (!(input.article.faq ?? []).length) style.push({ quote: input.article.title, problem: "No FAQ section.", fix: "End with three to six short questions and answers.", severity: "warn" });

  return { stats, unsourced, badLinks, style, banned };
}

// ---------- judge checks (generic prompts; the hosted verifier is tuned further) ----------

const CitationSchema = z.object({
  results: z.array(z.object({
    id: z.number().int(),
    verdict: z.enum(["supported", "partly_supported", "not_supported"]),
    note: z.string().describe("One sentence: what the source says, or what is missing"),
  })),
});

const EditorialSchema = z.object({
  voice_score: z.number().int().describe("0 to 100: how closely the article matches the customer's voice"),
  voice_issues: z.array(z.object({ quote: z.string(), problem: z.string(), fix: z.string() })),
  unsourced: z.array(z.object({ quote: z.string(), why: z.string() })),
  banned_hits: z.array(z.object({ banned_claim: z.string(), quote: z.string() })),
  unlabeled_opinions: z.array(z.object({ quote: z.string() })),
  answers_first: z.boolean(),
});

async function citationCheck(judge: Judge, input: QualityInput, list: Sentence[]): Promise<Issue[]> {
  const own = new Set((input.ownHosts ?? []).map((h) => h.toLowerCase()));
  const items: { id: number; sentence: Sentence; url: string; passages: string[] }[] = [];
  for (const s of list) {
    if (s.isOpinion) continue;
    const src = [...new Set(s.links)].map((u) => ({ u, src: findSource(u, input.sources) })).filter((x) => x.src && !own.has(hostOf(x.u)));
    if (!src.length || s.text.length < 30) continue;
    items.push({ id: items.length + 1, sentence: s, url: src[0].u, passages: src.flatMap((x) => bestPassages(s.text, x.src!.text, 3, 700)) });
  }
  const issues: Issue[] = [];
  for (let i = 0; i < items.length; i += 10) {
    const batch = items.slice(i, i + 10);
    const out = await judge.complete({
      purpose: "quality_citations",
      maxTokens: 8000,
      schema: CitationSchema,
      payload: { kind: "citations", items: batch.map((p) => ({ id: p.id, sentence: p.sentence.text, passages: p.passages })) },
      system: "You are a fact checker. For each item you get one sentence from an article and passages copied from the source it links. Decide only from those passages. 'supported' means the passages state it. 'partly_supported' means the gist is supported but the article adds a detail or certainty the passages do not have. 'not_supported' means the passages do not say it or say something different. Wording differences do not matter; only facts do.",
      prompt: batch.map((p) => `ITEM ${p.id}\nARTICLE SENTENCE: ${p.sentence.text}\nSOURCE PASSAGES:\n${p.passages.map((t, k) => `[${k + 1}] ${t}`).join("\n")}`).join("\n\n---\n\n"),
    });
    for (const r of out.results) {
      const p = batch.find((x) => x.id === r.id);
      if (!p || r.verdict === "supported") continue;
      issues.push({
        quote: clip(p.sentence.text),
        problem: `${r.verdict === "not_supported" ? "The linked source does not say this." : "The source only partly supports this."} ${r.note}`,
        fix: r.verdict === "not_supported" ? "Rewrite the sentence to match the source, link a source that does say it, or remove it." : "Trim the sentence to what the source actually says.",
        severity: r.verdict === "not_supported" ? "block" : "warn",
        sourceUrl: p.url,
      });
    }
  }
  return issues;
}

async function editorialCheck(judge: Judge, input: QualityInput) {
  const v = input.voice ?? {};
  return judge.complete({
    purpose: "quality_editorial",
    maxTokens: 8000,
    schema: EditorialSchema,
    payload: { kind: "editorial" },
    system: "You are an editor. Quote the article exactly in every issue. Be specific and brief. Do not invent problems: empty lists are fine.",
    prompt: `VOICE\n${v.description || "Plain, direct, specific writing."}\n\nBANNED CLAIMS (match paraphrases too):\n${(input.bannedClaims ?? []).map((c) => `- ${c}`).join("\n") || "- none"}\n\nTasks: voice_score and voice_issues; unsourced (specific checkable claims with no link); banned_hits; unlabeled_opinions; answers_first (does the first paragraph answer the title?).\n\nARTICLE\nTitle: ${input.article.title}\n\n${input.article.bodyMarkdown.slice(0, 30000)}`,
  });
}

// ---------- the verdict ----------

export async function checkArticle(input: QualityInput, judge: Judge, passScore = PASS_SCORE): Promise<Verdict> {
  const list = sentences(input.article.bodyMarkdown);
  const rules = ruleChecks(input, list);
  const [cites, editorial] = await Promise.all([citationCheck(judge, input, list), editorialCheck(judge, input)]);

  const unsourcedModel: Issue[] = editorial.unsourced.map((u) => ({ quote: clip(u.quote), problem: `No source for a specific claim. ${u.why}`, fix: "Link the source from the research, or remove the claim.", severity: "warn" as const }));
  const opinionIssues: Issue[] = editorial.unlabeled_opinions.map((o) => ({ quote: clip(o.quote), problem: "An opinion stated as a fact.", fix: "Label it as an opinion.", severity: "warn" as const }));
  const bannedModel: Issue[] = editorial.banned_hits.map((b) => ({ quote: clip(b.quote), problem: `Makes the banned claim "${b.banned_claim}".`, fix: "Remove or rewrite the sentence.", severity: "block" as const }));
  const voiceIssues: Issue[] = editorial.voice_issues.map((x) => ({ quote: clip(x.quote), problem: x.problem, fix: x.fix, severity: "warn" as const }));
  if (editorial.voice_score < 60) voiceIssues.unshift({ quote: input.article.title, problem: `Voice match is low (${editorial.voice_score} of 100).`, fix: "Rewrite closer to the stated voice.", severity: "block" });
  if (!editorial.answers_first) rules.style.push({ quote: clip(input.article.bodyMarkdown.split(/\n\s*\n/)[0] ?? ""), problem: "The first paragraph may not answer the question directly.", fix: "Answer the question in the first two or three sentences.", severity: "warn" });

  const mk = (id: CheckResult["id"], issues: Issue[], method: CheckResult["method"], detail?: string): CheckResult => ({
    id, label: LABELS[id], pass: !issues.some((i) => i.severity === "block"), issues, method, detail,
  });
  const checks: CheckResult[] = [
    mk("unsourced_claims", [...unsourcedModel, ...rules.unsourced, ...opinionIssues], "rules+model"),
    mk("made_up_stats", rules.stats, "rules", "Every number in a cited sentence was looked up in the saved source text."),
    mk("citation_mismatch", [...rules.badLinks, ...cites], "rules+model", "Each cited sentence was compared with the passages of its source."),
    mk("voice_drift", voiceIssues, "model", `Voice match ${editorial.voice_score} of 100.`),
    mk("banned_claims", [...rules.banned, ...bannedModel], "rules+model"),
    mk("house_style", rules.style, "rules+model"),
  ];

  const all = checks.flatMap((c) => c.issues);
  const blocks = all.filter((i) => i.severity === "block").length;
  const warns = all.length - blocks;
  const score = Math.max(0, Math.min(100, Math.round(100 - blocks * 12 - Math.min(20, warns * 2))));
  const pass = blocks === 0 && score >= passScore;
  const summary = pass
    ? `Passed. ${warns ? `${warns} small note${warns === 1 ? "" : "s"}.` : "No issues found."}`
    : `${blocks} issue${blocks === 1 ? "" : "s"} must be fixed before publishing${warns ? `, plus ${warns} small note${warns === 1 ? "" : "s"}` : ""}.`;
  return { pass, score, summary, judge: judge.id, checks };
}

/** Turns a verdict into instructions for the one rewrite. */
export function fixList(v: Verdict): string {
  return v.checks
    .flatMap((c) => c.issues.map((i) => `- [${c.label}${i.severity === "block" ? ", must fix" : ""}] "${i.quote}": ${i.problem} Fix: ${i.fix}`))
    .join("\n");
}

export { RuleJudge } from "./rule-judge";
export { LocalVerifier, HostedVerifier, getVerifier, registerVerifier, type Verifier } from "./verifier";
