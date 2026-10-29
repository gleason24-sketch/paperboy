// Onboarding step 2: read a site and describe it in plain words.
import { z } from "zod";
import { MODELS } from "@/config/models";
import { aiReady, Budget, structured } from "@/lib/ai/client";
import { brandColors, fetchPage, FetchError, logoUrl, safeUrl, sitemapUrls, type Page } from "@/lib/fetchpage";
import { domainOf, noDashesDeep } from "@/lib/util";

export type LinkPage = { url: string; title: string; why?: string };
export type ScanResult = {
  url: string;
  domain: string;
  name: string;
  what_you_do: string;
  who_you_serve: string;
  tone: string;
  offer: string;
  cta_text: string;
  cta_url: string;
  link_pages: LinkPage[];
  existing_posts: LinkPage[];
  /** Where the blog lives or should live: the site's existing blog section if we found one, else /blog. */
  blog_url: string;
  colors: { primary: string | null; text: string | null };
  logo_url: string | null;
  language: string;
  ai: boolean;
  cost_usd: number;
};

const SKIP = /\/(wp-admin|wp-login|login|signin|sign-in|signup|register|cart|checkout|account|privacy|terms|cookie|legal|tag|author|feed|cdn-cgi)\b|\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|xml)$/i;
const POSTISH = /\/(blog|news|articles?|guides?|posts?|insights|resources|learn)\//i;

const BLOG_SECTION = /^\/(blog|news|articles?|guides?|posts?|insights|resources|learn|journal|stories)$/i;

/** The address of the site's blog: the section most of its posts live under, a blog link in the menu, or /blog. */
export function guessBlogUrl(origin: string, home: Page, posts: LinkPage[]): string {
  const counts = new Map<string, number>();
  for (const p of posts) {
    try {
      const u = new URL(p.url);
      const seg = u.pathname.split("/").filter(Boolean)[0];
      if (seg) counts.set(`${u.origin}/${seg}`, (counts.get(`${u.origin}/${seg}`) ?? 0) + 1);
    } catch { /* bad url */ }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top) return top[0];
  for (const l of home.links) {
    try {
      const u = new URL(l.url);
      if (BLOG_SECTION.test(u.pathname.replace(/\/$/, ""))) return `${u.origin}${u.pathname.replace(/\/$/, "")}`;
      if (/^blog\./i.test(u.hostname) && domainOf(u.toString()).endsWith(domainOf(origin))) return u.origin;
    } catch { /* bad url */ }
  }
  return `${origin}/blog`;
}

function internalPages(home: Page, sitemap: string[]): { pages: LinkPage[]; posts: LinkPage[] } {
  const host = domainOf(home.finalUrl);
  const seen = new Map<string, string>();
  for (const l of home.links) {
    if (domainOf(l.url) !== host || SKIP.test(l.url)) continue;
    const clean = l.url.replace(/[?#].*$/, "").replace(/\/$/, "");
    if (clean === home.finalUrl.replace(/\/$/, "")) continue;
    if (!seen.has(clean) || (l.text && !seen.get(clean))) seen.set(clean, l.text);
  }
  for (const u of sitemap) {
    if (domainOf(u) !== host || SKIP.test(u)) continue;
    const clean = u.replace(/[?#].*$/, "").replace(/\/$/, "");
    if (!seen.has(clean)) seen.set(clean, "");
  }
  const titleFromPath = (u: string) => {
    const last = new URL(u).pathname.split("/").filter(Boolean).pop() ?? "";
    const t = decodeURIComponent(last).replace(/[-_]+/g, " ").replace(/\.\w+$/, "").trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : "Home";
  };
  const all = [...seen.entries()].map(([url, text]) => ({ url, title: text || titleFromPath(url) }));
  return { pages: all.filter((p) => !POSTISH.test(p.url)), posts: all.filter((p) => POSTISH.test(p.url)) };
}

const Schema = z.object({
  name: z.string().describe("The business or product name"),
  what_you_do: z.string().describe("One or two plain sentences: what the business sells or does"),
  who_you_serve: z.string().describe("One sentence: who the customers are"),
  tone: z.string().describe("A short description of the writing voice, e.g. 'Plain and friendly, short sentences, a little dry humor'"),
  offer: z.string().describe("The main thing a reader could buy, try or sign up for"),
  cta_text: z.string().describe("A short call to action naming that offer, e.g. 'Start a free trial'"),
  cta_url: z.string().describe("The best URL on the site for that call to action, from the list given"),
  link_pages: z.array(z.object({ url: z.string(), title: z.string(), why: z.string() })).describe("4 to 8 pages from the list worth linking to from articles"),
  language: z.string().describe("Two-letter language code of the site, e.g. en"),
});

export async function scanSite(url: string): Promise<ScanResult> {
  let home: Page;
  try {
    home = await fetchPage(url);
  } catch (e) {
    if (e instanceof FetchError) throw e;
    throw new FetchError("The site could not be read.");
  }
  const origin = new URL(home.finalUrl).origin;
  const sitemap = await sitemapUrls(origin);
  const { pages, posts } = internalPages(home, sitemap);

  // Read up to two more pages that explain the business.
  const explainers = pages.filter((p) => /about|pricing|product|features|services|how-it-works|solutions/i.test(p.url)).slice(0, 2);
  const extra = await Promise.all(explainers.map((p) => fetchPage(p.url, 10_000).catch(() => null)));
  const css = await firstStylesheet(home);
  const colors = brandColors(home, css);
  const base: ScanResult = {
    url: origin,
    domain: domainOf(origin),
    name: home.root.querySelector('meta[property="og:site_name"]')?.getAttribute("content")?.trim() || home.title.split(/[|\-:–—]/)[0].trim() || domainOf(origin),
    what_you_do: home.description || "",
    who_you_serve: "",
    tone: "",
    offer: "",
    cta_text: "",
    cta_url: origin,
    link_pages: pages.slice(0, 6),
    existing_posts: posts.slice(0, 200),
    blog_url: guessBlogUrl(origin, home, posts),
    colors: { primary: colors.primary, text: colors.text },
    logo_url: logoUrl(home),
    language: home.root.querySelector("html")?.getAttribute("lang")?.slice(0, 2) || "en",
    ai: false,
    cost_usd: 0,
  };
  if (!aiReady()) return base;

  const budget = new Budget({ ownerId: null, siteId: null, articleId: null }, { usd: 0.25, tokens: 200_000, searches: 0 });
  try {
    const out = await structured({
      model: MODELS.fast,
      purpose: "site_scan",
      budget,
      maxTokens: 5000,
      schema: Schema,
      system:
        "You read a company's website and describe it in plain, short sentences a busy owner would agree with. No hype, no marketing words, no em dashes. Only state what the pages actually say.",
      prompt: `Website: ${origin}
Title: ${home.title}
Description: ${home.description}

HOME PAGE TEXT:
${home.text.slice(0, 9000)}

${extra.filter(Boolean).map((p) => `PAGE ${p!.finalUrl}:\n${p!.text.slice(0, 4000)}`).join("\n\n")}

PAGES ON THE SITE (pick link_pages and cta_url only from these exact URLs):
${pages.slice(0, 80).map((p) => `${p.url} | ${p.title}`).join("\n") || origin}`,
    });
    const allowed = new Set([origin, ...pages.map((p) => p.url)]);
    const clean = noDashesDeep(out);
    return {
      ...base,
      name: clean.name || base.name,
      what_you_do: clean.what_you_do,
      who_you_serve: clean.who_you_serve,
      tone: clean.tone,
      offer: clean.offer,
      cta_text: clean.cta_text,
      cta_url: allowed.has(clean.cta_url.replace(/\/$/, "")) || allowed.has(clean.cta_url) ? clean.cta_url : origin,
      link_pages: clean.link_pages.filter((p) => allowed.has(p.url.replace(/\/$/, "")) || allowed.has(p.url)).slice(0, 8),
      language: clean.language || base.language,
      ai: true,
      cost_usd: budget.usd,
    };
  } catch (e) {
    console.error("scan ai step failed", e);
    return { ...base, cost_usd: budget.usd };
  }
}

async function firstStylesheet(home: Page): Promise<string> {
  const href = home.root.querySelector('link[rel="stylesheet"]')?.getAttribute("href");
  if (!href) return "";
  try {
    const r = await fetch(safeUrl(new URL(href, home.finalUrl).toString()), { signal: AbortSignal.timeout(8000) });
    return r.ok ? (await r.text()).slice(0, 400_000) : "";
  } catch {
    return "";
  }
}
