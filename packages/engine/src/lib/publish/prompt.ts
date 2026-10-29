// The prompt a customer pastes into an AI site builder (Claude Code, Lovable, Cursor, Bolt) to add a blog that pulls
// articles from our API. Plain instructions, no framework assumptions beyond "server-rendered pages".
import { appUrl, BRAND } from "@/config/brand";
import type { SiteRow } from "@/lib/types";

export function buildPrompt(site: SiteRow): string {
  const api = appUrl(`/api/public/v1/sites/${site.site_key}`);
  const base = (site.publish_config.blog_base_url || `${site.url}/blog`).replace(/\/+$/, "");
  const path = new URL(base).pathname || "/blog";
  return `Add a blog to this website at ${path} that shows articles from ${BRAND.name}, our article service.

Data source (public, read-only JSON, no API key needed):
- List: GET ${api}/articles
  Returns { "articles": [ { "slug", "title", "excerpt", "published_at", "updated_at" } ] }, newest first.
- One article: GET ${api}/articles/{slug}
  Returns { "title", "meta_title", "meta_description", "html", "faq_html", "schema_json_ld", "published_at", "updated_at", "canonical_url" }.
  Answers 404 when the slug does not exist.

Build these pages:
1. ${path}: a list of articles with title (linked), excerpt and date. Fetch on the server on every request, or cache for at most 10 minutes, so new articles appear on their own without a redeploy.
2. ${path}/[slug]: the article page.
   - <title> = meta_title, <meta name="description"> = meta_description, <link rel="canonical" href={canonical_url}>.
   - Render "title" as the H1, then "html", then "faq_html", using this site's existing fonts, colors, header and footer. The HTML is already sanitized.
   - Add schema_json_ld to the page head as <script type="application/ld+json">{JSON.stringify(schema_json_ld)}</script>.
   - Return a real 404 page when the API answers 404.
   - Style tables, lists and headings inside the article so they are easy to read; keep line length around 70 characters.
3. Add every article URL to this site's sitemap.xml, with <lastmod> = updated_at (fetch ${api}/articles when the sitemap is built or requested).
4. Serve the plain text file /${site.indexnow_key}.txt at the root of this site containing exactly: ${site.indexnow_key}
   (this lets search engines confirm new articles come from us).
5. Add a "Blog" link to the main navigation.

Render on the server (server components, SSR or ISR), not only in the browser, so search engines and AI assistants can read the articles. Do not copy the articles into the codebase; always read them from the API.`;
}
