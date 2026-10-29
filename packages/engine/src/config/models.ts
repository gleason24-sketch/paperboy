// SPDX-License-Identifier: AGPL-3.0-only
// The one place model names, prices and per-article limits live. Change a model here and every step follows.
//
// Claude (Anthropic) is the product's AI for everything: writing, research, the fact check, topics, site scans.
// Anthropic's commercial terms rule out training on customer content, so Search Console data may go into prompts.
// Claude model IDs checked against Anthropic's model list on 2026-10-03.

export const MODELS: { writer: string; fast: string } = {
  // writer: writing and the one rewrite after a failed quality check.
  // fast: reading sources, the quality check, topic picking, site scan and other small jobs.
  writer: "claude-sonnet-5-5",
  fast: "claude-haiku-4-5",
};

// USD per million tokens (first-party prices).
export const PRICES: Record<string, { in: number; out: number; cacheRead?: number; cacheWrite?: number }> = {
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-4-5": { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

// Per web search: Anthropic's server tool is $10 per 1,000.
export const WEB_SEARCH_USD = 0.01;

// Anthropic server tool version. Haiku 4.5 only supports the basic web search variant.
export const WEB_SEARCH_TOOL = (maxUses: number) =>
  ({ type: "web_search_20250305", name: "web_search", max_uses: maxUses }) as const;

// Hard limits per article. A job that would cross one of these stops and is held for review.
export const LIMITS = {
  maxSearches: 6,
  maxUsd: 1.5,
  maxTokens: 600_000, // input + output across every call for one article
  maxSources: 6,
  sourceChars: 24_000, // saved text per source
};

// Quality gate.
export const QUALITY = {
  passScore: 70,
};
