// Turns a saved quality verdict into the props of the FactCheckPanel. Pure (no database, no React), so it is easy to test.
// A "claim" here is a sentence that carries a source link: each one went through the number check and the citation
// comparison. A claim counts as checked unless a blocking issue quotes it. This counts what the check looked at; it is
// not a promise about sentences that carry no citation.
import { hostOf, sentences } from "./text";
import type { CheckResult } from "./types";

export type PanelCheck = { id: string; label: string; state: "pass" | "held"; detail?: string };
export type PanelNote = { quote: string; problem: string; severity: "block" | "warn" };
export type PanelSource = { host: string; selling: boolean };
export type PanelData = {
  title: string;
  /** Public address of the article, shown as a mono line. */
  url?: string;
  /** Internal path to read the article. */
  href?: string;
  checks: PanelCheck[];
  claimsChecked: number;
  claimsTotal: number;
  sourcesRead: number;
  sources?: PanelSource[];
  score?: number;
  passed: boolean;
  /** ISO date of the verdict. */
  checkedOn?: string;
  notes: PanelNote[];
};

/** Shortest honest line for a check: what it found, or how many items it flagged. Never the model's raw prose. */
function detailFor(c: CheckResult): string | undefined {
  if (c.pass) return c.detail && c.detail.length <= 96 ? c.detail : undefined;
  const n = c.issues.filter((i) => i.severity === "block").length || c.issues.length;
  return n ? `${n} ${n === 1 ? "item" : "items"} held for a fix` : "Held for review";
}

export function countClaims(bodyMarkdown: string, checks: CheckResult[]): { total: number; checked: number } {
  const claims = sentences(bodyMarkdown).filter((s) => s.links.length > 0);
  const blocked = checks.flatMap((c) => c.issues.filter((i) => i.severity === "block").map((i) => i.quote.slice(0, 40)));
  const bad = claims.filter((s) => blocked.some((q) => q && s.text.includes(q))).length;
  return { total: claims.length, checked: Math.max(0, claims.length - bad) };
}

export function panelFromVerdict(
  v: { score: number; pass: boolean; checks: CheckResult[]; created_at?: string | Date },
  opts: { title: string; url?: string; href?: string; bodyMarkdown?: string; sources?: { url: string; selling?: boolean }[] },
): PanelData {
  const { total, checked } = opts.bodyMarkdown ? countClaims(opts.bodyMarkdown, v.checks) : { total: 0, checked: 0 };
  const sources = (opts.sources ?? []).filter((s) => hostOf(s.url)).map((s) => ({ host: hostOf(s.url), selling: !!s.selling }));
  return {
    title: opts.title,
    url: opts.url,
    href: opts.href,
    checks: v.checks.map((c) => ({ id: c.id, label: c.label, state: c.pass ? "pass" : "held", detail: detailFor(c) })),
    claimsChecked: checked,
    claimsTotal: total,
    sourcesRead: sources.length,
    sources,
    score: v.score,
    passed: v.pass,
    checkedOn: v.created_at ? new Date(v.created_at).toISOString() : undefined,
    notes: v.checks.flatMap((c) => c.issues.map((i) => ({ quote: i.quote, problem: i.problem, severity: i.severity }))),
  };
}
