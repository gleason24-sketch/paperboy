// SPDX-License-Identifier: AGPL-3.0-only
// Publishing pace per plan. A self-hosted instance has no billing: set a site's plan to choose how often it publishes.
// (Prices and checkout belong to the hosted product and are not part of this repository.)

export type PlanId = "starter" | "growth" | "pro";

export const PLANS: Record<PlanId, { name: string; perWeek: number }> = {
  starter: { name: "Starter", perWeek: 3 },
  growth: { name: "Growth", perWeek: 7 },
  pro: { name: "Pro", perWeek: 14 },
};

export const PLAN_IDS = Object.keys(PLANS) as PlanId[];

/** Facts an article may quote about the product itself. Empty in the open build. */
export const planFactLines = (): string[] => [];
export const planFactsText = (): string => "";
