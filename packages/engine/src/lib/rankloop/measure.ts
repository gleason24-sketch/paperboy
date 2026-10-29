// Scores a title/meta change (pure, unit-tested): Search Console clicks, CTR and position for the 28 days before the change
// against the 28 days after. A change is only scored when there is enough data to say anything.

export type Stats = { clicks: number; impressions: number; position: number | null };
export type Outcome = "win" | "loss" | "neutral";

export const MIN_IMPRESSIONS = 20;
export const MEASURE_AFTER_DAYS = 30; // 28 days of data plus Search Console's lag of about 2 days

const ctr = (s: Stats) => (s.impressions > 0 ? s.clicks / s.impressions : 0);
const change = (a: number, b: number) => (a > 0 ? (b - a) / a : b > 0 ? 1 : 0);

/**
 * win: click-through rate up by 15 percent or more and clicks not down by more than 10 percent.
 * loss: click-through rate down by 15 percent or more, or clicks down by 20 percent or more while impressions held up
 *   (a fall in impressions alone is demand or ranking, not the title).
 * neutral: everything else, including too little data.
 */
export function scoreTest(before: Stats, after: Stats): { outcome: Outcome; note: string } {
  if (before.impressions < MIN_IMPRESSIONS || after.impressions < MIN_IMPRESSIONS) return { outcome: "neutral", note: "Too few impressions to tell." };
  const dCtr = change(ctr(before), ctr(after));
  const dClicks = change(before.clicks, after.clicks);
  const dImpr = change(before.impressions, after.impressions);
  const pct = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`;
  const note = `Click-through ${pct(dCtr)}, clicks ${pct(dClicks)}, impressions ${pct(dImpr)}.`;
  if (dCtr >= 0.15 && dClicks > -0.1) return { outcome: "win", note };
  if (dCtr <= -0.15 || (dClicks <= -0.2 && dImpr > -0.2)) return { outcome: "loss", note };
  return { outcome: "neutral", note };
}
