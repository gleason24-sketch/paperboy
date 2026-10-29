// Every model call goes through here (Claude, models set in src/config/models.ts), so every call is priced,
// logged per customer and checked against the per-article caps.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { LIMITS, MODELS, PRICES, WEB_SEARCH_TOOL, WEB_SEARCH_USD } from "@/config/models";
import { sql } from "@/lib/db";

let client: Anthropic | null = null;
export function anthropic(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new AiNotConfigured();
  client = new Anthropic({ apiKey, maxRetries: 3, timeout: 10 * 60_000 });
  return client;
}
export const aiReady = () => !!process.env.ANTHROPIC_API_KEY;

export class AiNotConfigured extends Error {
  constructor() {
    super(`The writing service is not connected yet (ANTHROPIC_API_KEY is missing).`);
  }
}
export class CapReached extends Error {
  constructor(public what: "cost" | "tokens" | "searches", detail: string) {
    super(detail);
  }
}
export class Refused extends Error {}

type UsageLike = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
};

export function priceOf(model: string, u: UsageLike): { usd: number; tin: number; tout: number; searches: number } {
  const p = PRICES[model] ?? PRICES[MODELS.writer];
  const tin = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const tout = u.output_tokens ?? 0;
  const searches = u.server_tool_use?.web_search_requests ?? 0;
  const usd =
    ((u.input_tokens ?? 0) * p.in +
      (u.cache_read_input_tokens ?? 0) * (p.cacheRead ?? p.in) +
      (u.cache_creation_input_tokens ?? 0) * (p.cacheWrite ?? p.in * 1.25) +
      tout * p.out) /
      1e6 +
    searches * WEB_SEARCH_USD;
  return { usd, tin, tout, searches };
}

/** Tracks spend for one job (an article, a site scan) and stops it at the caps. */
export class Budget {
  usd = 0;
  tokens = 0;
  searches = 0;
  constructor(
    public ctx: { ownerId: string | null; siteId: string | null; articleId: string | null },
    public caps = { usd: LIMITS.maxUsd, tokens: LIMITS.maxTokens, searches: LIMITS.maxSearches },
    start?: { usd?: number; tokens?: number; searches?: number },
  ) {
    this.usd = start?.usd ?? 0;
    this.tokens = start?.tokens ?? 0;
    this.searches = start?.searches ?? 0;
  }
  searchesLeft() {
    return Math.max(0, this.caps.searches - this.searches);
  }
  /** Throws before a call if the job is already at a cap, or if the call's worst case would cross the dollar cap. */
  guard(model: string, maxOut: number) {
    if (this.usd >= this.caps.usd) throw new CapReached("cost", `Stopped at the $${this.caps.usd.toFixed(2)} cost cap for one article.`);
    if (this.tokens >= this.caps.tokens) throw new CapReached("tokens", `Stopped at the ${this.caps.tokens.toLocaleString()} token cap for one article.`);
    const p = PRICES[model];
    if (p && this.usd + (maxOut * p.out) / 1e6 > this.caps.usd * 1.15)
      throw new CapReached("cost", `The next step could cross the $${this.caps.usd.toFixed(2)} cost cap, so the article was stopped.`);
  }
  async record(model: string, purpose: string, u: UsageLike) {
    const c = priceOf(model, u);
    this.usd += c.usd;
    this.tokens += c.tin + c.tout;
    this.searches += c.searches;
    if (this.ctx.ownerId) {
      const db = sql();
      await db`insert into ai_usage (owner_id, site_id, article_id, purpose, model, tokens_in, tokens_out, searches, cost_usd)
        values (${this.ctx.ownerId}, ${this.ctx.siteId}, ${this.ctx.articleId}, ${purpose}, ${model}, ${c.tin}, ${c.tout}, ${c.searches}, ${c.usd})`;
      if (this.ctx.articleId)
        await db`update articles set cost_usd = cost_usd + ${c.usd}, tokens_in = tokens_in + ${c.tin}, tokens_out = tokens_out + ${c.tout},
          searches = searches + ${c.searches} where id = ${this.ctx.articleId}`;
    }
    return c;
  }
}

const SONNET_FALLBACK_BETA = "server-side-fallback-2026-07-01";

type StructuredOpts<S extends z.ZodType> = {
  model: string;
  system: string;
  prompt: string;
  schema: S;
  maxTokens: number;
  budget: Budget;
  purpose: string;
  effort?: "low" | "medium" | "high" | "max";
};

/** One call that must return JSON matching `schema`. */
export async function structured<S extends z.ZodType>(o: StructuredOpts<S>): Promise<z.infer<S>> {
  o.budget.guard(o.model, o.maxTokens);
  const isSonnet = o.model.startsWith("claude-sonnet");
  const stream = anthropic().beta.messages.stream({
    model: o.model,
    max_tokens: o.maxTokens,
    system: o.system,
    messages: [{ role: "user", content: o.prompt }],
    output_config: { format: betaZodOutputFormat(o.schema), ...(isSonnet ? { effort: o.effort === "max" ? "high" : o.effort ?? "medium" } : {}) },
    // Sonnet 5.5 can decline a request on a safety classifier; "default" retries it on Anthropic's recommended model.
    ...(isSonnet ? { betas: [SONNET_FALLBACK_BETA], fallbacks: "default" as const } : {}),
  });
  const msg = await stream.finalMessage();
  await o.budget.record(o.model, o.purpose, msg.usage as UsageLike);
  if (msg.stop_reason === "refusal") throw new Refused("The writing model declined this topic.");
  if (msg.stop_reason === "max_tokens") throw new Error(`The ${o.purpose} step ran out of room (max_tokens). Try again; the article was not changed.`);
  const parsed = (msg as unknown as { parsed_output?: z.infer<S> | null }).parsed_output;
  if (parsed) return parsed;
  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return o.schema.parse(JSON.parse(text));
}

export type Found = { url: string; title: string };

/** A web-search turn on the fast model. Returns the model's answer plus every result URL the search returned. */
export async function searchTurn(o: { system: string; prompt: string; maxSearches: number; maxTokens: number; budget: Budget; purpose: string }) {
  const uses = Math.min(o.maxSearches, o.budget.searchesLeft());
  if (uses <= 0) throw new CapReached("searches", `Used all ${o.budget.caps.searches} web searches for this article.`);
  o.budget.guard(MODELS.fast, o.maxTokens);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: o.prompt }];
  const found: Found[] = [];
  let text = "";
  // pause_turn: the server paused a long search turn; send it back to continue (at most twice).
  for (let turn = 0; turn < 3; turn++) {
    const msg = await anthropic().messages.create({
      model: MODELS.fast,
      max_tokens: o.maxTokens,
      system: o.system,
      messages,
      tools: [WEB_SEARCH_TOOL(uses)],
    });
    await o.budget.record(MODELS.fast, o.purpose, msg.usage as UsageLike);
    for (const b of msg.content) {
      if (b.type === "text") text += b.text;
      if (b.type === "web_search_tool_result" && Array.isArray(b.content))
        for (const r of b.content) if (r.type === "web_search_result") found.push({ url: r.url, title: r.title });
    }
    if (msg.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: msg.content });
  }
  return { text, found };
}

/** Pulls the first JSON array or object out of free text. */
export function extractJson<T>(text: string): T | null {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as T;
  } catch {
    return null;
  }
}
