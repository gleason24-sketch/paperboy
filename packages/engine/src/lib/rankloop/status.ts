// Per-site rank loop status (pure, unit-tested), same rules as the Marketing Hub scoreboard:
//   NO_GSC   no Search Console property, or no Search Console rows in the last 7 days: the loop is blind
//   STALLED  ctr_fix + needs_own_page open, no fix shipped in 7 days, and the site has been tracked for 7+ days
//   BEHIND   fewer than 5 fixes shipped in 7 days while 5 or more opportunities are open
//   OK       otherwise
// A "fix" is a page whose title or meta description changed (a seo_tests row), whether Paperboy made it or the customer did.
export type RankStatus = "NO_GSC" | "STALLED" | "BEHIND" | "OK";

export const OPP_TYPES = ["ctr_fix", "needs_own_page", "push_to_1", "striking_distance", "cluster", "slipping"] as const;
export type OppType = (typeof OPP_TYPES)[number];
export type OppCounts = Record<OppType, number>;

export type LoopStats = {
  hasProperty: boolean;
  lastDataDate: string | null; // YYYY-MM-DD of the newest gsc_rows date
  trackingSince: string | null; // when Search Console was connected
  open: Partial<OppCounts>;
  fixes7d: number;
  fixes28d: number;
  lastFixAt: string | null;
  tests: { win: number; loss: number; neutral: number; pending: number };
};

export const FRESH_DAYS = 7;
export const STALLED_AFTER_DAYS = 7;
export const BEHIND_FIXES = 5;
export const BEHIND_OPEN = 5;

const DAY = 864e5;
const dayNumber = (ymd: string) => Math.floor(Date.parse(`${ymd.slice(0, 10)}T00:00:00Z`) / DAY);

export function rankLoopStatus(s: LoopStats, now = new Date()) {
  const today = dayNumber(now.toISOString());
  const fresh = !!s.lastDataDate && today - dayNumber(s.lastDataDate) <= FRESH_DAYS;
  const connected = s.hasProperty && fresh;
  const open = Object.fromEntries(OPP_TYPES.map((t) => [t, connected ? (s.open[t] ?? 0) : 0])) as OppCounts;
  const openTotal = OPP_TYPES.reduce((n, t) => n + open[t], 0);
  const urgent = open.ctr_fix + open.needs_own_page;
  const setUpDays = s.trackingSince ? today - dayNumber(s.trackingSince) : 0;

  let status: RankStatus = "OK";
  if (!connected) status = "NO_GSC";
  else if (urgent > 0 && s.fixes7d === 0 && setUpDays >= STALLED_AFTER_DAYS) status = "STALLED";
  else if (s.fixes7d < BEHIND_FIXES && openTotal >= BEHIND_OPEN) status = "BEHIND";

  const fixes = (n: number) => (n === 1 ? "1 fix" : `${n} fixes`);
  const say =
    status === "NO_GSC"
      ? !s.hasProperty ? "Connect Search Console so Paperboy can see which searches your pages show up for." : "No fresh Search Console data yet. Paperboy checks again every day."
      : status === "STALLED"
        ? `${urgent} fixes are waiting and none went out in the last 7 days.`
        : status === "BEHIND"
          ? `${fixes(s.fixes7d)} went out in the last 7 days and ${openTotal} are waiting.`
          : `${fixes(s.fixes7d)} went out in the last 7 days. ${openTotal} are waiting.`;
  return { status, say, connected, open, openTotal, fixes7d: s.fixes7d, fixes28d: s.fixes28d, lastFixAt: s.lastFixAt, tests: s.tests };
}
export type RankLoopStatus = ReturnType<typeof rankLoopStatus>;

const ORDER: Record<RankStatus, number> = { NO_GSC: 0, STALLED: 1, BEHIND: 2, OK: 3 };
/** NO_GSC and STALLED first, then BEHIND, then OK; by domain inside each group. */
export const sortRankLoop = <T extends { status: RankStatus; domain: string }>(rows: T[]): T[] =>
  rows.slice().sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.domain.localeCompare(b.domain));
