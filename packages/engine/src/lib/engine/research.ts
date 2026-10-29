// Step 2: research. Search the web, open the best sources ourselves, save their exact text, and have the fast model
// read each one for checkable facts with verbatim quotes (quotes that are not in the text are dropped).
import { z } from "zod";
import { LIMITS, MODELS } from "@/config/models";
import { CapReached, extractJson, searchTurn, structured, type Budget, type Found } from "@/lib/ai/client";
import { fetchPage } from "@/lib/fetchpage";
import { domainOf, noDashesDeep } from "@/lib/util";

export type Fact = { claim: string; quote: string };
export type SourceDoc = { url: string; title: string; text: string; selling: boolean; selling_note: string; summary: string; facts: Fact[] };

const BLOCKED = /(pinterest|facebook|instagram|tiktok|twitter|x\.com|youtube|linkedin\.com\/posts|quora|reddit\.com\/r\/[^/]+\/?$)/i;

export async function findSources(topic: { target_query: string; topic: string; angle: string }, siteDomain: string, budget: Budget): Promise<Found[]> {
  const left = Math.max(1, Math.min(4, budget.searchesLeft()));
  const r = await searchTurn({
    budget,
    purpose: "research_search",
    maxSearches: left,
    maxTokens: 5000,
    system:
      "You are a research librarian. Find the most trustworthy pages for a writer. Prefer primary sources: government and regulator pages, official documentation, standards bodies, original studies and surveys, and the company's own page when a claim is about that company. Avoid content farms, social media, and pages that only repeat other pages.",
    prompt: `Article: "${topic.topic}"
Target search: "${topic.target_query}"
Angle: ${topic.angle}

Search for sources (up to ${left} searches). Then reply with ONLY a JSON array of the ${LIMITS.maxSources} best pages, best first:
[{"url": "...", "title": "...", "why": "what checkable facts it has"}]
Do not include ${siteDomain} itself.`,
  });
  const picked = extractJson<{ url: string; title: string }[]>(r.text) ?? [];
  const merged: Found[] = [];
  const seen = new Set<string>();
  for (const f of [...picked, ...r.found]) {
    if (!f?.url || !/^https?:\/\//.test(f.url)) continue;
    const d = domainOf(f.url);
    if (!d || d === siteDomain || BLOCKED.test(f.url) || seen.has(f.url)) continue;
    seen.add(f.url);
    merged.push({ url: f.url, title: f.title ?? d });
  }
  return merged.slice(0, LIMITS.maxSources + 4);
}

const Reading = z.object({
  selling: z.boolean().describe("True if the page's owner sells the product or service the page discusses, or earns from recommending it (affiliate links, sponsored)"),
  selling_note: z.string().describe("If selling: one short sentence, e.g. 'Acme sells payroll software.' Otherwise empty."),
  summary: z.string().describe("Two sentences on what the page covers and how reliable it is"),
  facts: z.array(z.object({
    claim: z.string().describe("The fact in plain words"),
    quote: z.string().describe("The exact words from the page that state it, copied character for character, at most 300 characters"),
  })).describe("Up to 12 specific, checkable facts relevant to the article: numbers, rules, prices, dates, steps, definitions"),
});

const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

export async function readSources(found: Found[], topic: { target_query: string }, budget: Budget, onProgress?: (note: string) => Promise<void>): Promise<SourceDoc[]> {
  const docs: SourceDoc[] = [];
  // Open every candidate page, each with a hard time limit. A page that blocks or stalls our fetch is skipped.
  type Opened = { f: Found; url: string; title: string; text: string };
  const open = async (f: Found): Promise<Opened | null> => {
    const own = await withTimeout(fetchPage(f.url, 12_000), 20_000).catch(() => null);
    if (own && own.text.length >= 600) return { f, url: own.finalUrl, title: own.title, text: own.text };
    return null;
  };
  const pages = await Promise.all(found.map(open));
  const usable = pages.filter((x): x is Opened => !!x).slice(0, LIMITS.maxSources);
  await onProgress?.(`Opened ${usable.length} of ${found.length} pages. Reading them for checkable facts`);
  let read = 0;
  // Three at a time keeps us inside the AI provider's concurrency limits.
  for (let i = 0; i < usable.length; i += 3) {
    await Promise.all(
      usable.slice(i, i + 3).map(async ({ f, url, title, text: full }) => {
        const text = full.slice(0, LIMITS.sourceChars);
        // One unreadable source should not sink the article; cap errors still stop it.
        const out = await withTimeout(
          structured({
            model: MODELS.fast,
            purpose: "read_source",
            budget,
            maxTokens: 8000,
            schema: Reading,
            system: "You read one web page for a fact-checked article. Copy quotes exactly from the page text. If the page has no useful facts, return an empty list.",
            prompt: `Article target search: "${topic.target_query}"\nPage: ${url}\nTitle: ${title}\n\nPAGE TEXT:\n${text}`,
          }),
          180_000,
        ).catch((e) => {
          if (e instanceof CapReached) throw e;
          console.warn(`skipped source ${url}: ${(e as Error).message}`);
          return null;
        });
        if (!out) return;
        const hay = norm(text);
        const facts = out.facts.filter((x) => x.quote && hay.includes(norm(x.quote)));
        docs.push({ url, title: title || f.title, text, selling: out.selling, selling_note: noDashesDeep(out.selling_note), summary: noDashesDeep(out.summary), facts });
        read++;
        await onProgress?.(`Read ${read} of ${usable.length} sources`);
      }),
    );
  }
  // Keep the order the search ranked them in.
  return docs.sort((a, b) => usable.findIndex((u) => u.url === a.url) - usable.findIndex((u) => u.url === b.url));
}

/** Rejects if the promise takes longer than ms. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
