// SPDX-License-Identifier: AGPL-3.0-only
// Funnel analytics hooks. The open build records nothing; the hosted product swaps in its own tracker.
export type StepTimes = Record<string, string>;

export type TrackInput = {
  event: string;
  userId?: string | null;
  siteId?: string | null;
  articleId?: string | null;
  props?: Record<string, unknown>;
  dedupeKey?: string | null;
};

export async function trackEvent(_i: TrackInput): Promise<boolean> {
  return false;
}

/** Seconds between consecutive step timestamps (ISO strings), ending at `endedAt`. */
export function stepSeconds(times: StepTimes | null | undefined, endedAt: string | Date): Record<string, number> {
  const out: Record<string, number> = {};
  if (!times) return out;
  const entries = Object.entries(times).sort((a, b) => Date.parse(a[1]) - Date.parse(b[1]));
  const end = new Date(endedAt).getTime();
  entries.forEach(([k, t], i) => {
    const next = i + 1 < entries.length ? Date.parse(entries[i + 1][1]) : end;
    out[k] = Math.max(0, Math.round((next - Date.parse(t)) / 1000));
  });
  return out;
}
