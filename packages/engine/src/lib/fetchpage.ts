// Fetches a web page and pulls out what the product needs: readable text, links, title, colors, logo.
import { lookup } from "node:dns/promises";
import { parse, type HTMLElement } from "node-html-parser";

const UA = "Mozilla/5.0 (compatible; PaperboyBot/1.0; +https://github.com/paperboyseo/paperboy)";

export type Page = {
  url: string;
  finalUrl: string;
  status: number;
  title: string;
  description: string;
  text: string;
  links: { url: string; text: string }[];
  html: string;
  root: HTMLElement;
};

export class FetchError extends Error {}

/** Blocks private and local addresses so a pasted URL can never reach internal services. */
export function safeUrl(raw: string): URL {
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol)) throw new FetchError("Only http and https addresses work.");
  const h = u.hostname.toLowerCase();
  if (
    h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") ||
    /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h === "[::1]" || /^\d+$/.test(h)
  ) throw new FetchError("That address points to a private network.");
  return u;
}

const PRIVATE_IP = /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|fc|fd|fe80:)/i;

/** Resolves the host and refuses private addresses (stops DNS tricks that point a public name at an internal service). */
export async function assertPublicHost(host: string) {
  try {
    const addrs = await lookup(host, { all: true });
    if (addrs.some((a) => PRIVATE_IP.test(a.address))) throw new FetchError("That address points to a private network.");
  } catch (e) {
    if (e instanceof FetchError) throw e;
    throw new FetchError("That web address does not exist. Check the spelling.");
  }
}

export async function fetchPage(url: string, timeoutMs = 15_000): Promise<Page> {
  const u = safeUrl(url);
  await assertPublicHost(u.hostname);
  let res: Response;
  try {
    res = await fetch(u, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "Accept-Language": "en-US,en;q=0.8" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new FetchError(/timeout|abort/i.test(msg) ? "The site took too long to answer." : "The site could not be reached.");
  }
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok) throw new FetchError(`The site answered with an error (HTTP ${res.status}).`);
  if (!/html|xml|text\/plain/.test(type)) throw new FetchError("That address is not a web page.");
  const html = (await res.text()).slice(0, 2_000_000);
  return parseHtml(html, res.url || u.toString(), res.status);
}

export function parseHtml(html: string, finalUrl: string, status = 200): Page {
  const root = parse(html, { comment: false, blockTextElements: { script: true, style: true, noscript: false, pre: true } });
  const meta = (sel: string) => root.querySelector(sel)?.getAttribute("content")?.trim() ?? "";
  const title = (root.querySelector("title")?.text ?? meta('meta[property="og:title"]')).trim().replace(/\s+/g, " ");
  const description = meta('meta[name="description"]') || meta('meta[property="og:description"]');
  const base = new URL(finalUrl);
  const links: { url: string; text: string }[] = [];
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    try {
      const abs = new URL(href, base);
      abs.hash = "";
      links.push({ url: abs.toString(), text: a.text.trim().replace(/\s+/g, " ").slice(0, 120) });
    } catch { /* bad href */ }
  }
  return { url: finalUrl, finalUrl, status, title, description, text: readableText(root), links, html, root };
}

/** The main text of a page: prefers <article> or <main>, drops navigation, footers, scripts and forms. */
export function readableText(root: HTMLElement): string {
  const clone = parse(root.toString());
  for (const sel of ["script", "style", "noscript", "svg", "nav", "footer", "header", "form", "iframe", "aside", "[aria-hidden=true]", ".cookie", "#cookie"])
    for (const el of clone.querySelectorAll(sel)) el.remove();
  const main = clone.querySelector("article") ?? clone.querySelector("main") ?? clone.querySelector("[role=main]") ?? clone.querySelector("body") ?? clone;
  const blocks: string[] = [];
  for (const el of main.querySelectorAll("h1, h2, h3, h4, p, li, td, th, blockquote, pre, dd, dt, figcaption")) {
    // Skip nested duplicates: a <p> inside an <li> is read through the <li>.
    if (el.parentNode && (el.parentNode as HTMLElement).rawTagName?.match(/^(li|td|th|blockquote)$/i) && el.rawTagName.toLowerCase() === "p") continue;
    const t = el.text.replace(/\s+/g, " ").trim();
    if (t.length < 2) continue;
    const tag = el.rawTagName.toLowerCase();
    blocks.push(tag.startsWith("h") ? `\n## ${t}` : tag === "li" ? `- ${t}` : t);
  }
  let text = blocks.join("\n");
  if (text.length < 300) text = main.text.replace(/\s+/g, " ").trim();
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/** Brand colors from the page: theme-color, CSS custom properties and the most used saturated colors in inline CSS. */
export function brandColors(page: Page, extraCss = ""): { primary: string | null; text: string | null; background: string | null } {
  const theme = page.root.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null;
  const css = [...page.root.querySelectorAll("style")].map((s) => s.text).join("\n") + "\n" + extraCss +
    "\n" + [...page.root.querySelectorAll("[style]")].map((e) => e.getAttribute("style")).join(";");
  const counts = new Map<string, number>();
  for (const m of css.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    let h = m[1].toLowerCase();
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  const sat = (h: string) => {
    const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    return { s: max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1)), l };
  };
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const saturated = ranked.filter(([h]) => { const { s, l } = sat(h); return s > 0.35 && l > 0.2 && l < 0.7; });
  const dark = ranked.filter(([h]) => { const { s, l } = sat(h); return l < 0.25 && s < 0.4; });
  const valid = (c: string | null) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : null);
  return {
    primary: valid(theme) && sat(theme!.slice(1).toLowerCase()).s > 0.2 ? theme!.toLowerCase() : saturated[0] ? `#${saturated[0][0]}` : null,
    text: dark[0] ? `#${dark[0][0]}` : null,
    background: null,
  };
}

/** Best guess at the site's logo URL. */
export function logoUrl(page: Page): string | null {
  const base = new URL(page.finalUrl);
  const abs = (s: string | undefined | null) => { try { return s ? new URL(s, base).toString() : null; } catch { return null; } };
  for (const img of page.root.querySelectorAll("header img, nav img, a[href='/'] img, img")) {
    const hint = `${img.getAttribute("src")} ${img.getAttribute("alt")} ${img.getAttribute("class")} ${img.getAttribute("id")}`.toLowerCase();
    if (hint.includes("logo")) return abs(img.getAttribute("src") ?? img.getAttribute("data-src"));
  }
  const icon = page.root.querySelector('link[rel="apple-touch-icon"]') ?? page.root.querySelector('link[rel="icon"][sizes]') ?? page.root.querySelector('link[rel="icon"]');
  return abs(icon?.getAttribute("href")) ?? abs(page.root.querySelector('meta[property="og:image"]')?.getAttribute("content"));
}

/** URLs from the site's sitemap (follows one level of sitemap index). */
export async function sitemapUrls(origin: string, limit = 300): Promise<string[]> {
  const get = async (u: string) => {
    try {
      const r = await fetch(safeUrl(u), { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10_000) });
      return r.ok ? (await r.text()).slice(0, 3_000_000) : "";
    } catch { return ""; }
  };
  const locs = (xml: string) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
  let xml = await get(`${origin}/sitemap.xml`);
  if (!xml) xml = await get(`${origin}/sitemap_index.xml`);
  if (!xml) return [];
  let urls = locs(xml);
  if (/<sitemapindex/i.test(xml)) {
    const children = urls.filter((u) => !/image|video/i.test(u)).slice(0, 4);
    urls = (await Promise.all(children.map(get))).flatMap(locs);
  }
  return [...new Set(urls)].slice(0, limit);
}
