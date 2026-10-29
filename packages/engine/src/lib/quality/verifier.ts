// SPDX-License-Identifier: AGPL-3.0-only
// The verifier boundary. The pipeline asks getVerifier() for a Verifier and never knows which one it got.
//
//   LocalVerifier   open: the rule checks in index.ts plus any Judge (rule-based, or a model with your own key)
//   HostedVerifier  optional: one API call to the hosted fact check at paperboyseo.com (or any compatible server)
//   registerVerifier()  how a private build plugs in its own implementation without forking the pipeline
import type { Budget } from "@/lib/ai/client";
import { QUALITY } from "@/config/models";
import { checkArticle } from "./index";
import { defaultJudge } from "./judges";
import type { Judge, QualityInput, Verdict } from "./types";

export interface Verifier {
  id: string;
  verify(input: QualityInput): Promise<Verdict>;
}

export class LocalVerifier implements Verifier {
  id: string;
  constructor(private judge: Judge, private passScore = QUALITY.passScore) {
    this.id = `local:${judge.id}`;
  }
  verify(input: QualityInput) {
    return checkArticle(input, this.judge, this.passScore);
  }
}

/** Sends the article and the saved source text to the hosted verifier: POST {baseUrl}/api/v1/verify, Bearer key, answer { verdict }. */
export class HostedVerifier implements Verifier {
  id = "hosted";
  constructor(private opts: { apiKey: string; baseUrl?: string; fetch?: typeof fetch }) {}
  async verify(input: QualityInput): Promise<Verdict> {
    const base = (this.opts.baseUrl || "https://paperboyseo.com").replace(/\/+$/, "");
    const r = await (this.opts.fetch ?? fetch)(`${base}/api/v1/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error(`Hosted verifier answered ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
    const body = (await r.json()) as { verdict?: Verdict };
    if (!body.verdict || typeof body.verdict.pass !== "boolean" || !Array.isArray(body.verdict.checks)) throw new Error("Hosted verifier returned an unexpected answer.");
    return body.verdict;
  }
}

let registered: ((budget: Budget) => Verifier) | null = null;

/** A private build registers its own verifier once at startup. */
export function registerVerifier(factory: (budget: Budget) => Verifier) {
  registered = factory;
}

/** Order: a registered verifier, then the hosted one (PAPERBOY_VERIFIER=hosted plus PAPERBOY_API_KEY), then the local one. */
export function getVerifier(budget: Budget): Verifier {
  if (registered) return registered(budget);
  if (process.env.PAPERBOY_VERIFIER === "hosted" && process.env.PAPERBOY_API_KEY)
    return new HostedVerifier({ apiKey: process.env.PAPERBOY_API_KEY, baseUrl: process.env.PAPERBOY_BASE_URL });
  return new LocalVerifier(defaultJudge(budget));
}
