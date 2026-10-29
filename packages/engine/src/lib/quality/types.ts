// SPDX-License-Identifier: AGPL-3.0-only
// Public types for the quality check module. This module has no database, framework or product imports, so it can be
// lifted out and sold on its own: give it an article, the saved source text, the voice and the banned claims; get a verdict.
import type { z } from "zod";

export type QualitySource = {
  url: string;
  title?: string;
  /** The exact text that was read from the source when the article was researched. */
  text: string;
  /** True when the source is selling the thing it talks about (a vendor page, an affiliate review). */
  selling?: boolean;
};

export type QualityInput = {
  article: { title: string; bodyMarkdown: string; faq?: { q: string; a: string }[] };
  sources: QualitySource[];
  voice?: {
    description?: string;
    interview?: { q: string; a: string }[];
    wordsToAvoid?: string[];
  };
  /** Claims the customer never wants made, in their own words ("We are the cheapest", "guaranteed results"). */
  bannedClaims?: string[];
  /** Hosts that count as the customer's own site (internal links are not citations). */
  ownHosts?: string[];
};

export type CheckId = "unsourced_claims" | "made_up_stats" | "citation_mismatch" | "voice_drift" | "banned_claims" | "house_style";

export type Issue = {
  /** The exact text from the article the issue is about. */
  quote: string;
  problem: string;
  fix: string;
  /** "block" stops publishing; "warn" lowers the score only. */
  severity: "block" | "warn";
  sourceUrl?: string;
};

export type CheckResult = {
  id: CheckId;
  label: string;
  pass: boolean;
  issues: Issue[];
  /** How the check was made: rule-based against the source text, by the judging model, or both. */
  method: "rules" | "model" | "rules+model";
  detail?: string;
};

export type Verdict = {
  pass: boolean;
  score: number;
  summary: string;
  judge: string;
  checks: CheckResult[];
};

/** The same request in structured form, for judges that do not read prompts (the rule-based judge). */
export type JudgePayload =
  | { kind: "citations"; items: { id: number; sentence: string; passages: string[] }[] }
  | { kind: "editorial" };

/** The judging model. Swap it by passing a different Judge to checkArticle. */
export interface Judge {
  /** Short id saved with each verdict, e.g. "haiku-4.5" or "jev". */
  id: string;
  /** Answer one prompt with JSON matching the schema. */
  complete<S extends z.ZodType>(req: { system: string; prompt: string; schema: S; maxTokens: number; purpose: string; payload?: JudgePayload }): Promise<z.infer<S>>;
}
