// SPDX-License-Identifier: AGPL-3.0-only
// Helpers for the fact-check endpoints: turn a web page into Markdown that keeps its links, find the cited sources,
// and map a quality Verdict onto the flat claim list the REST API returns. Pure functions, no network or database.
import { parse, type HTMLElement, type Node } from "node-html-parser";
import { sentences, type Sentence } from "@/lib/quality/text";
import type { Verdict } from "@/lib/quality/types";

export type ClaimStatus = "verified" | "held" | "unsupported" | "mismatch";
export type ClaimCheck = { claim: string; status: ClaimStatus; source?: string; note?: string };

const DROP = new Set(["script", "style", "noscript", "svg", "nav", "footer", "header", "form", "iframe", "aside", "button", "select", "template"]);
const BLOCK = new Set(["p", "div", "section", "article", "main", "ul", "ol", "table", "tr", "blockquote", "pre", "figure", "figcaption", "dl", "dt", "dd", "li"]);

/** Converts the main content of an HTML page to Markdown, keeping links as [text](absolute-url) so citations survive. */
export function htmlToMarkdown(html: string, baseUrl: string): string {
  const root = parse(html, { comment: false, blockTextElements: { script: false, style: false, noscript: false, pre: true } });
  const main = root.querySelector("article") ?? root.querySelector("main") ?? root.querySelector("[role=main]") ?? root.querySelector("body") ?? root;
  const out: string[] = [];
  const walk = (node: Node): string => {
    if (node.nodeType === 3) return node.text.replace(/\s+/g, " ");
    if (node.nodeType !== 1) return "";
    const el = node as HTMLElement;
    const tag = (el.rawTagName || "").toLowerCase();
    if (DROP.has(tag)) return "";
    const inner = () => el.childNodes.map(walk).join("");
    if (tag === "a") {
      const text = inner().replace(/\s+/g, " ").trim();
      const href = el.getAttribute("href") ?? "";
      if (!text || /^(mailto:|tel:|javascript:|#)/i.test(href)) return text;
      try {
        const abs = new URL(href, baseUrl);
        abs.hash = "";
        if (!/^https?:$/.test(abs.protocol)) return text;
        return `[${text.replace(/[\[\]]/g, "")}](${abs.toString().replace(/\)/g, "%29")})`;
      } catch {
        return text;
      }
    }
    if (tag === "br") return "\n";
    if (/^h[1-6]$/.test(tag)) {
      const t = inner().replace(/\s+/g, " ").trim();
      return t ? `\n\n${"#".repeat(Number(tag[1]))} ${t}\n\n` : "";
    }
    if (tag === "li") return `\n- ${inner().replace(/\s+/g, " ").trim()}\n`;
    if (tag === "td" || tag === "th") return ` ${inner().replace(/\s+/g, " ").trim()} |`;
    if (tag === "tr") return `\n|${inner()}\n`;
    if (BLOCK.has(tag)) return `\n\n${inner()}\n\n`;
    return inner();
  };
  out.push(main.childNodes.map(walk).join(""));
  return out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Every http(s) link in Markdown, in order of first appearance, without duplicates. */
export function extractLinks(markdown: string): string[] {
  const seen = new Set<string>();
  for (const m of markdown.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) seen.add(m[1]);
  return [...seen];
}

export function hostOfUrl(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** The first Markdown H1, or the first line, used as the title when only Markdown was given. */
export function titleOfMarkdown(md: string): string {
  const h = /^#\s+(.+)$/m.exec(md);
  if (h) return h[1].trim().slice(0, 200);
  const first = md.split("\n").find((l) => l.trim());
  return (first ?? "Untitled").replace(/^#+\s*/, "").slice(0, 200);
}

const norm = (s: string) => s.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

/** Issue quotes are clipped to 220 characters with an ellipsis, so match on the unclipped start. */
function quoteMatches(quote: string, sentence: string): boolean {
  const q = norm(quote).replace(/…$/, "");
  const s = norm(sentence);
  if (q.length < 3) return false;
  return s.startsWith(q) || s.includes(q) || (q.length > 40 && q.includes(s));
}

const isClaim = (s: Sentence) => !s.isOpinion && !s.isExample && (s.links.length > 0 || s.numbers.length > 0 || s.factSignal);

export type MapOptions = {
  /** Cited URLs that could not be opened, with the reason. Claims that rest on them are `unsupported`. */
  unreadable?: Map<string, string>;
};

/**
 * Flattens a Verdict into claim checks. A claim is a sentence with a number, a link or a factual signal. It is `verified`
 * unless a blocking issue quotes it: a source that does not say it is `mismatch`, a claim with no usable source is
 * `unsupported`, and anything else (style, banned claims, voice) is `held`.
 */
export function verdictToChecks(verdict: Verdict, markdown: string, opts: MapOptions = {}): ClaimCheck[] {
  const unreadable = opts.unreadable ?? new Map<string, string>();
  const issues = verdict.checks.flatMap((c) => c.issues.map((i) => ({ ...i, check: c.id })));
  const blocks = issues.filter((i) => i.severity === "block");
  const used = new Set<number>();
  const checks: ClaimCheck[] = [];

  for (const s of sentences(markdown).filter(isClaim)) {
    const claim = s.text.length > 240 ? `${s.text.slice(0, 239)}…` : s.text;
    const dead = s.links.find((u) => unreadable.has(u));
    const source = dead ?? s.links[0];
    const hit = blocks.findIndex((i, idx) => !used.has(idx) && quoteMatches(i.quote, s.text));
    if (dead && !s.links.some((u) => !unreadable.has(u))) {
      if (hit >= 0) used.add(hit);
      checks.push({ claim, status: "unsupported", source: dead, note: `The cited source could not be opened: ${unreadable.get(dead)}` });
      continue;
    }
    if (hit < 0) {
      const warn = issues.find((i) => i.severity === "warn" && quoteMatches(i.quote, s.text));
      checks.push({ claim, status: "verified", ...(source ? { source } : {}), ...(warn ? { note: warn.problem } : {}) });
      continue;
    }
    used.add(hit);
    const issue = blocks[hit];
    let status: ClaimStatus = "held";
    if (issue.check === "citation_mismatch" || (issue.check === "made_up_stats" && issue.sourceUrl)) status = "mismatch";
    else if (issue.check === "unsourced_claims" || issue.check === "made_up_stats") status = "unsupported";
    checks.push({ claim, status, ...(issue.sourceUrl || source ? { source: issue.sourceUrl ?? source } : {}), note: issue.problem });
  }

  // Blocking problems that are not about one claim (style, banned claims, links to unread pages) are still reported as held.
  blocks.forEach((i, idx) => {
    if (used.has(idx)) return;
    checks.push({ claim: i.quote, status: i.check === "citation_mismatch" ? "mismatch" : "held", ...(i.sourceUrl ? { source: i.sourceUrl } : {}), note: i.problem });
  });
  return checks;
}

/** The article endpoint only knows verified or held. */
export function simplifyChecks(checks: ClaimCheck[]): { claim: string; status: "verified" | "held"; source: string | null }[] {
  return checks.map((c) => ({ claim: c.claim, status: c.status === "verified" ? "verified" : "held", source: c.source ?? null }));
}
