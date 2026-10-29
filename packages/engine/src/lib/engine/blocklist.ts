// Paperboy's own site does not write new "[big competitor] alternatives" posts while its authority is low.
// Existing posts stay. Small-tool comparisons (Arvow, Abun, RankYak, RightBlogger, SEObot, BoltSEO) are allowed.
import { ALTERNATIVE_TERMS, BLOCKED_ALTERNATIVES, OWN_AUTHORITY_UNLOCK, ownSiteAuthority, type Competitor } from "@/config/serp-gate";
import { ownSiteId } from "@/lib/own-blog";

const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, " ").replace(/\.(?=\s|$)/g, "").trim().split(/\s+/).filter(Boolean);

/** Index ranges [start, end) of every occurrence of the phrase (space separated words) in the token list. */
function find(toks: string[], phrase: string): number[] {
  const p = tokens(phrase);
  const hits: number[] = [];
  for (let i = 0; i + p.length <= toks.length; i++) if (p.every((w, k) => toks[i + k] === w)) hits.push(i);
  return hits;
}

/** Plain words next to each other count as "about" when the gap is at most this many words. */
const NEAR = 4;

/**
 * The competitor an "alternatives" topic is about, or null. A topic matches when a blocked name sits within a few
 * words of an alternatives phrase ("Surfer SEO alternatives", "best alternatives to Jasper", "Koala AI alternative that fact checks").
 * The company name alone is not enough ("how to outrank competitors" is fine), and neither is the phrase alone.
 */
export function alternativesOf(text: string, list: Competitor[] = BLOCKED_ALTERNATIVES): Competitor | null {
  const toks = tokens(text);
  if (!toks.length) return null;
  const alts = ALTERNATIVE_TERMS.flatMap((t) => find(toks, t).map((i) => ({ i, len: tokens(t).length })));
  if (!alts.length) return null;
  for (const c of list) {
    for (const n of c.names) {
      const len = tokens(n).length;
      for (const i of find(toks, n)) {
        if (alts.some((a) => (a.i >= i + len ? a.i - (i + len) : i - (a.i + a.len)) <= NEAR)) return c;
      }
    }
  }
  return null;
}

/** True while the blocklist applies to Paperboy's own site (its authority is not above the unlock level). */
export const ownBlocklistActive = () => ownSiteAuthority() <= OWN_AUTHORITY_UNLOCK;

/**
 * Why a topic may not be written for this site, or null. Only Paperboy's own site has a blocklist; customer sites are not touched.
 * `parts` are the topic title and the search it targets: either one matching blocks it.
 */
export function blockedReason(site: { id: string }, ...parts: (string | null | undefined)[]): string | null {
  // OWN_SITE_ID names the site. Without it (a self-hosted copy has no own site) the blocklist does not apply.
  const own = ownSiteId();
  if (!own || site.id !== own || !ownBlocklistActive()) return null;
  for (const t of parts) {
    const c = t ? alternativesOf(t) : null;
    if (c) return `blocked: "${c.name} alternatives" posts are paused on this site until its domain authority is above ${OWN_AUTHORITY_UNLOCK}`;
  }
  return null;
}
