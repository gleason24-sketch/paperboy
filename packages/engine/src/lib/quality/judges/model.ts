// SPDX-License-Identifier: AGPL-3.0-only
// Model judge: the fast model (Claude Haiku 4.5) with your own Anthropic key, through the metered client, so every
// judging call is priced and logged.
import type { z } from "zod";
import { MODELS } from "@/config/models";
import { structured, type Budget } from "@/lib/ai/client";
import type { Judge } from "../types";

export class FastModelJudge implements Judge {
  id = MODELS.fast;
  constructor(private budget: Budget) {}
  complete<S extends z.ZodType>(req: { system: string; prompt: string; schema: S; maxTokens: number; purpose: string; payload?: unknown }): Promise<z.infer<S>> {
    const { payload: _payload, ...rest } = req;
    return structured({ model: MODELS.fast, budget: this.budget, ...rest });
  }
}
