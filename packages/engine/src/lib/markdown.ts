// Article Markdown to HTML, plus the structured data (Article + FAQPage) every published article carries.
import { marked } from "marked";
import { escapeHtml } from "@/lib/util";

marked.setOptions({ gfm: true, breaks: false });

/** Safe HTML from the writer's Markdown: raw HTML in the Markdown is escaped, links get rel attributes. */
export function mdToHtml(md: string, ownHost?: string): string {
  const renderer = new marked.Renderer();
  renderer.html = ({ text }) => escapeHtml(text);
  renderer.link = ({ href, title, tokens }) => {
    const text = marked.Parser.parseInline(tokens, { renderer });
    const safe = /^(https?:|mailto:|\/|#)/i.test(href) ? href : "#";
    let external = false;
    try { external = /^https?:/i.test(safe) && !!ownHost && new URL(safe).hostname.replace(/^www\./, "") !== ownHost.replace(/^www\./, ""); } catch { /* relative */ }
    return `<a href="${escapeHtml(safe)}"${title ? ` title="${escapeHtml(title)}"` : ""}${external ? ' rel="noopener" target="_blank"' : ""}>${text}</a>`;
  };
  renderer.table = (token) => {
    const head = token.header.map((c) => `<th${c.align ? ` style="text-align:${c.align}"` : ""}>${marked.Parser.parseInline(c.tokens, { renderer })}</th>`).join("");
    const rows = token.rows.map((r) => `<tr>${r.map((c) => `<td${c.align ? ` style="text-align:${c.align}"` : ""}>${marked.Parser.parseInline(c.tokens, { renderer })}</td>`).join("")}</tr>`).join("");
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  };
  return marked.parse(md, { renderer, async: false }) as string;
}

export function faqHtml(faq: { q: string; a: string }[]): string {
  if (!faq.length) return "";
  return `<section class="faq"><h2>Frequently asked questions</h2>${faq
    .map((f) => `<h3>${escapeHtml(f.q)}</h3>${mdToHtml(f.a)}`)
    .join("")}</section>`;
}

export function articleSchema(a: {
  title: string; description: string; url: string; publishedAt: string; updatedAt?: string;
  publisherName: string; publisherUrl: string; logoUrl?: string | null; imageUrl?: string | null; faq: { q: string; a: string }[];
  /** Trail from the home page to this article, last item last; adds a BreadcrumbList. */
  breadcrumbs?: { name: string; url: string }[];
}) {
  const org = { "@type": "Organization", name: a.publisherName, url: a.publisherUrl, ...(a.logoUrl ? { logo: { "@type": "ImageObject", url: a.logoUrl } } : {}) };
  const strip = (s: string) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`#>]/g, "");
  const out: Record<string, unknown>[] = [
    {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: a.title.slice(0, 110),
      description: a.description,
      datePublished: a.publishedAt,
      dateModified: a.updatedAt ?? a.publishedAt,
      url: a.url,
      mainEntityOfPage: { "@type": "WebPage", "@id": a.url },
      ...(a.imageUrl ? { image: [a.imageUrl] } : {}),
      author: org,
      publisher: org,
    },
  ];
  if (a.breadcrumbs?.length) out.push(breadcrumbSchema(a.breadcrumbs));
  if (a.faq.length)
    out.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: a.faq.map((f) => ({ "@type": "Question", name: strip(f.q), acceptedAnswer: { "@type": "Answer", text: strip(f.a) } })),
    });
  return out;
}

/** BreadcrumbList for a page: pass the trail from the home page down to the page itself. */
export function breadcrumbSchema(trail: { name: string; url: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((t, i) => ({ "@type": "ListItem", position: i + 1, name: t.name, item: t.url })),
  };
}

/** HowTo for a tool page. Steps must match what the page really asks the visitor to do. */
export function howToSchema(h: { name: string; description: string; url?: string; steps: { name: string; text: string }[] }) {
  return {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: h.name,
    description: h.description,
    ...(h.url ? { url: h.url } : {}),
    step: h.steps.map((s, i) => ({ "@type": "HowToStep", position: i + 1, name: s.name, text: s.text })),
  };
}

/** A standalone FAQPage for pages that are not blog posts (blog posts get theirs from articleSchema). */
export function faqPageSchema(faq: { q: string; a: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
}

/** The JSON-LD as a script tag. `<` is escaped so content can never close the tag. */
export const schemaScript = (schema: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, "\\u003c")}</script>`;
