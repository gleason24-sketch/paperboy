// SPDX-License-Identifier: AGPL-3.0-only
import type { Budget } from "@/lib/ai/client";
import type { Judge } from "../types";
import { FastModelJudge } from "./model";
import { RuleJudge } from "../rule-judge";

/** A model judge when ANTHROPIC_API_KEY is set, otherwise the rule-based judge (no model, no cost). */
export function defaultJudge(budget: Budget): Judge {
  return process.env.ANTHROPIC_API_KEY ? new FastModelJudge(budget) : new RuleJudge();
}
