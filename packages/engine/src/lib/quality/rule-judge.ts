// SPDX-License-Identifier: AGPL-3.0-only
// The open rule-based judge. It answers the same questions as a model judge, but only from the words on the page:
// a cited sentence counts as supported when most of its content words appear in the best source passages.
// It is deliberately strict about what it can see and silent about what it cannot (voice, opinions), so it never
// invents a problem. Use it with no API key at all, or as a free first pass in CI.
import type { z } from "zod";
import type { Judge, JudgePayload } from "./types";

const STOP = new Set("the and for are but not you your with that this from have has had was were will can may its their they them our out all any one two more most than then also into over about when what which who how why per each other such only just been being does did doing very".split(" "));

const words = (s: string) => (s.toLowerCase().match(/[a-z0-9][a-z0-9'-]+/g) ?? []).filter((w) => w.length > 3 && !STOP.has(w));

/** Share of the sentence's content words that appear in the passages (0 to 1). */
export function overlap(sentence: string, passages: string[]): number {
  const want = [...new Set(words(sentence))];
  if (!want.length) return 1;
  const have = new Set(passages.flatMap(words));
  return want.filter((w) => have.has(w) || [...have].some((h) => h.length > 5 && w.length > 5 && h.slice(0, 5) === w.slice(0, 5))).length / want.length;
}

export class RuleJudge implements Judge {
  id = "rules-v1";
  async complete<S extends z.ZodType>(req: { system: string; prompt: string; schema: S; maxTokens: number; purpose: string; payload?: JudgePayload }): Promise<z.infer<S>> {
    const p = req.payload;
    if (p?.kind === "citations") {
      const results = p.items.map((it) => {
        const share = overlap(it.sentence, it.passages);
        const verdict = share >= 0.6 ? "supported" : share >= 0.35 ? "partly_supported" : "not_supported";
        return { id: it.id, verdict, note: `${Math.round(share * 100)} percent of this sentence's key words appear in the source passages.` };
      });
      return req.schema.parse({ results });
    }
    // Voice, unlabeled opinions and unsourced-claim hunting need judgment; the rule judge reports nothing rather than guess.
    return req.schema.parse({ voice_score: 100, voice_issues: [], unsourced: [], banned_hits: [], unlabeled_opinions: [], answers_first: true });
  }
}
