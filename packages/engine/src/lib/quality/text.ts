// Rule-based helpers: split an article into sentences with their links, find numbers, and look numbers and passages
// up in saved source text. Pure functions, unit tested in tests/quality.test.ts.

export type Sentence = {
  text: string; // plain text, links reduced to their anchor text
  raw: string; // original Markdown
  links: string[];
  numbers: string[];
  isExample: boolean;
  isOpinion: boolean;
  factSignal: boolean;
  section: string;
  /** Index of the paragraph, list item or table cell the sentence belongs to. */
  para: number;
  /** For table rows and list items: the links of the paragraph that introduces the table or list (its lead-in), if any. */
  leadLinks: string[];
};

const LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;

export const EXAMPLE = /\b(for example|for instance|say (a|an|you|your|the|it)|let'?s say|imagine|suppose|made[- ]up|hypothetical|illustrat|e\.g\.|example,? not real|example only)\b/i;
/** Labels that switch a whole section into "made-up example" mode (stricter than EXAMPLE, which also matches "for example"). */
export const MADE_UP = /\b(made[- ]up|hypothetical|not real data|worked example|illustrative example|example,? not real)\b/i;
/** Sentences that show their own arithmetic ("$1,500 plus 12 times $297 equals $5,064"). */
export const CALC = /\b(times|plus|minus|equals|multiplied by|divided by|works out to|comes to|adds up to|my math)\b|\s[×=]\s/i;
export const OPINION = /\b(my (arithmetic|math|calculation|estimate)|not a sourced (fact|number|figure)|i think|i'd|i would|in my (view|opinion|experience)|my (take|view|judgment|opinion)|our (take|view|opinion)|we think|we'd|opinion|not a sourced fact|rule of thumb|i suggest|i recommend|we recommend|my advice|advice,? not)\b/i;
const FACT_WORDS = /\b(study|studies|survey|research|report(ed|s)?|according to|data (from|shows)|percent|statistic|average|median|law|regulation|requires?|required|official|announced|launched|founded|costs?|priced at|fee of|rate of|million|billion)\b/i;

/** Numbers worth checking: percentages, money, decimals, numbers with thousands separators, and numbers of 2+ digits. */
export function findNumbers(s: string): string[] {
  const out: string[] = [];
  // A formula ("B x C / 60", "hours = minutes / 60") is arithmetic, not a claim.
  if (/[A-Za-z0-9)]\s+[x×*\/]\s+[A-Za-z0-9(]|\s=\s/.test(s) && !/[$€£%]/.test(s)) return out;
  const re = /(?<![\w.])(\$|€|£)?\d{1,3}(?:,\d{3})+(?:\.\d+)?%?|(?<![\w.])(\$|€|£)?\d+(?:\.\d+)?\s?(?:%|percent\b|per cent\b)?/gi;
  for (const m of s.matchAll(re)) {
    const v = m[0].trim();
    const digits = v.replace(/[^\d]/g, "");
    const special = /[%$€£.,]|percent/i.test(v);
    if (!special && (digits.length < 2 || Number(digits) <= 12)) continue; // "3 steps", "Step 1", "multiply by 12"
    if (/^\$?0(\.0+)?$/.test(v.replace(/[,\s]/g, ""))) continue; // "$0"
    if (/^(19|20)\d\d$/.test(v)) continue; // a year on its own ("in 2026") is a date, not a statistic
    if (!special && ["24", "52", "60", "100", "365", "1000"].includes(digits)) continue; // unit constants (hours, weeks, minutes)
    out.push(v);
  }
  return out;
}

const norm = (s: string) =>
  s.toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/ /g, " ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ");

/** Is this number present in the source text, allowing for formatting differences (1,200 vs 1200, 45% vs 45 percent). */
export function numberInText(num: string, sourceText: string): boolean {
  const text = norm(sourceText);
  const core = num.replace(/[$€£\s]/g, "").replace(/,/g, "").replace(/percent|per cent/i, "%").toLowerCase();
  const isPct = core.endsWith("%");
  const value = core.replace(/%$/, "");
  if (!value) return true;
  const esc = value.replace(/\./g, "\\.");
  const bounded = new RegExp(`(?<![\\d.])${esc}(?![\\d]|\\.\\d)`);
  if (!bounded.test(text)) {
    // 2.0 vs 2, 50.00 vs 50
    const trimmed = value.includes(".") ? value.replace(/\.?0+$/, "") : null;
    if (!trimmed || trimmed === value || !new RegExp(`(?<![\\d.])${trimmed.replace(/\./g, "\\.")}(?![\\d]|\\.\\d)`).test(text)) return false;
  }
  if (isPct) return new RegExp(`(?<![\\d.])${esc}\\s?(%|percent|per cent|percentage)`).test(text) || bounded.test(text);
  return true;
}

/** Splits Markdown into sentences, tracking which links each sentence carries and which H2 section it sits in. */
export function sentences(md: string): Sentence[] {
  const out: Sentence[] = [];
  let section = "";
  let para = 0;
  // Once a section says it is a made-up example, the arithmetic that follows in that section is part of it.
  let exampleSection = false;
  // Links of the last plain paragraph in this section: the lead-in that a following table or list rests on.
  let lead: string[] = [];
  for (const rawLine of md.split(/\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) { section = h[1].trim(); exampleSection = MADE_UP.test(section); lead = []; continue; }
    if (/^\|?\s*:?-{3,}/.test(line)) continue; // table separator row
    const body = line.replace(/^([-*+]|\d+\.)\s+/, "").replace(/^>\s?/, "").replace(/^\[[ xX]\]\s+/, "");
    const grouped = /^\|/.test(line) || /^([-*+]|\d+\.)\s+/.test(line);
    const cells = body.includes("|") ? body.split("|").map((c) => c.trim()).filter(Boolean) : [body];
    // A table row is one unit: a link in any cell sources the numbers in that row.
    if (cells.length > 1) para++;
    for (const cell of cells) {
      if (cells.length === 1) para++;
      // Split on sentence ends that are not inside a link or a decimal number.
      const parts = cell.replace(LINK, (m) => m.replace(/\./g, "\u0000")).split(/(?<=[.!?])\s+(?=[A-Z0-9"(\[])/);
      for (let p of parts) {
        p = p.replace(/\u0000/g, ".");
        const links = [...p.matchAll(LINK)].map((m) => m[2]);
        const text = p.replace(LINK, "$1").replace(/[*_`]/g, "").trim();
        if (text.length < 3) continue;
        out.push({
          text,
          raw: p,
          links,
          numbers: findNumbers(text),
          isExample: (exampleSection ||= MADE_UP.test(text)) || EXAMPLE.test(text),
          isOpinion: OPINION.test(text),
          factSignal: FACT_WORDS.test(text),
          section,
          para,
          leadLinks: grouped ? lead : [],
        });
      }
    }
    if (!grouped) lead = [...line.matchAll(LINK)].map((m) => m[2]);
  }
  return out;
}

/** The passages of a source most likely to support a sentence: overlapping word windows ranked by shared words. */
export function bestPassages(sentence: string, sourceText: string, count = 3, size = 700): string[] {
  const stop = new Set("the a an and or of to in for on with is are was were be by as at it its this that from your you we our can will not".split(" "));
  const words = (s: string) => norm(s).replace(/[^a-z0-9%.$ ]+/g, " ").split(" ").filter((w) => w.length > 2 && !stop.has(w));
  const want = new Set(words(sentence));
  if (!sourceText) return [];
  const step = Math.floor(size / 2);
  const scored: { start: number; score: number }[] = [];
  for (let i = 0; i < sourceText.length; i += step) {
    const chunk = sourceText.slice(i, i + size);
    const ws = words(chunk);
    let score = 0;
    for (const w of new Set(ws)) if (want.has(w)) score += /\d/.test(w) ? 3 : 1;
    scored.push({ start: i, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const picked: number[] = [];
  for (const s of scored) {
    if (picked.length >= count) break;
    if (picked.some((p) => Math.abs(p - s.start) < size)) continue;
    picked.push(s.start);
  }
  return picked.sort((a, b) => a - b).map((p) => sourceText.slice(p, p + size).trim());
}

export const sameUrl = (a: string, b: string) => {
  const k = (u: string) => { try { const x = new URL(u); return `${x.hostname.replace(/^www\./, "")}${x.pathname.replace(/\/$/, "")}`; } catch { return u; } };
  return k(a) === k(b);
};

export const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };

/** Words and phrases that mark machine-written or hype copy. */
export const HYPE = [
  /\bin today'?s (fast-paced|digital|ever-changing|modern) (world|landscape|age)\b/i, /\bdelve(s|d)? into\b/i, /\bgame[- ]changer\b/i,
  /\bunlock (the|your) (power|potential|secrets?)\b/i, /\bleverag(e|ing) the power\b/i, /\bseamless(ly)?\b/i, /\belevate your\b/i,
  /\bin conclusion\b/i, /\blook no further\b/i, /\bat the end of the day\b/i, /\bwe'?ve got you covered\b/i, /\bdive (deep|in|into)\b/i,
  /\ba testament to\b/i, /\bthe (ultimate|comprehensive|definitive) guide\b/i, /\bmultifaceted\b/i, /\bembark on\b/i, /\btapestry\b/i,
  /\bin the realm of\b/i, /\bharness the\b/i, /\bcutting[- ]edge\b/i, /\bwithout further ado\b/i, /\blet'?s (dive|explore|unpack)\b/i,
  /\bnot only .{3,60} but also\b/i, /\brevolutioniz(e|ing)\b/i, /\bsupercharge\b/i, /\bunparalleled\b/i, /\bbest-in-class\b/i,
];
