// Title and meta description rules for the rank loop (pure, unit-tested): the checks a generated rewrite must pass,
// and the prompt text that carries this site's own winning and losing title styles back into the generator.
import { tokens } from "./opps";

export const TITLE_MAX = 60;
export const META_MIN = 120;
export const META_MAX = 155;

export type TitleMeta = { title: string; meta: string };

const DASH = /[\u2013\u2014]/;
const PROMISE = /\b(guarantee[sd]?|guaranteed|#\s?1|number one|rank(s|ing)? (first|higher)|top of google|first page of google)\b/i;

/** Why a title/meta pair is not usable, or an empty list when it passes. `query` is the exact top query the title must lead with. */
export function titleMetaIssues(t: TitleMeta, query: string, now = new Date()): string[] {
  const out: string[] = [];
  const title = t.title.trim(), meta = t.meta.trim();
  if (!title) out.push("title is empty");
  if (title.length > TITLE_MAX) out.push(`title is ${title.length} characters, the limit is ${TITLE_MAX}`);
  if (meta.length < META_MIN || meta.length > META_MAX) out.push(`meta description is ${meta.length} characters, it must be ${META_MIN} to ${META_MAX}`);
  if (DASH.test(title) || DASH.test(meta)) out.push("uses a dash as punctuation");
  if (PROMISE.test(title) || PROMISE.test(meta)) out.push("promises a ranking or a result");
  const qt = tokens(query);
  if (qt.length) {
    const front = new Set(tokens(title.slice(0, 40)));
    const hit = qt.filter((w) => front.has(w)).length;
    if (hit / qt.length < 0.6) out.push("the top query is not near the front of the title");
  }
  const year = now.getUTCFullYear();
  for (const y of `${title} ${meta}`.match(/\b20\d\d\b/g) ?? []) if (Number(y) < year) out.push(`mentions a past year (${y})`);
  return out;
}

export type Test = { outcome: "pending" | "win" | "loss" | "neutral"; new_title: string | null; old_title: string | null };

/** Prompt block with this site's measured title styles (never another customer's). Empty when nothing has been measured. */
export function styleBlock(tests: Test[]): string {
  const wins = tests.filter((t) => t.outcome === "win" && t.new_title).slice(0, 6);
  const losses = tests.filter((t) => t.outcome === "loss" && t.new_title).slice(0, 6);
  if (!wins.length && !losses.length) return "";
  const lines = (xs: Test[]) => xs.map((t) => `- "${t.new_title}"`).join("\n");
  return `TITLE STYLES MEASURED ON THIS SITE (28 days of Search Console clicks before and after):
${wins.length ? `Earned more clicks, copy their shape:\n${lines(wins)}\n` : ""}${losses.length ? `Lost clicks, avoid their shape:\n${lines(losses)}\n` : ""}`;
}

/** Fits a title the model returned a little long: cut at the last whole word, never mid-word. Returns null if nothing sensible remains. */
export function clampTitle(title: string): string | null {
  const t = title.trim();
  if (t.length <= TITLE_MAX) return t;
  const cut = t.slice(0, TITLE_MAX + 1).replace(/\s+\S*$/, "").replace(/[\s:,;|-]+$/, "");
  return cut.length >= 20 ? cut : null;
}
