// Settings for the SERP-strength gate (src/lib/engine/serp-gate.ts) and the own-site competitor blocklist.
// Everything here is plain data so it can be changed in one place.

/**
 * Authority proxy. There is no free, keyless "domain authority" number, so a domain counts as STRONG when it is in the
 * Tranco top 100,000 (tranco-list.eu, a research ranking built from five traffic and link datasets, refreshed daily).
 * Mapping: Tranco rank <= 100,000 is treated as "authority above 40" (roughly Moz DA / Ahrefs DR 40 and up; sites at
 * that level are almost always inside the top 100k, while most small sites with DA/DR under 30 are far outside it).
 * It is a rough proxy, not a score. Change the number here (or with SERP_STRONG_RANK) to make the gate stricter or looser.
 */
export const STRONG_RANK = Math.max(1000, Number(process.env.SERP_STRONG_RANK) || 100_000);
/** How many of the top 1M the daily list download keeps (the 1M file is 20 MB; the top 100k is 2 MB and is all the gate reads). */
export const TRANCO_KEEP = STRONG_RANK;
/** Re-download the Tranco list when the stored copy is older than this many days. */
export const TRANCO_MAX_AGE_DAYS = 7;

/** "More than half of the top 10" strong means skip. */
export const STRONG_SHARE_TO_SKIP = 0.5;
/** Fewer results than this and the check is too thin to skip a topic on (it passes and is logged as unchecked). */
export const MIN_RESULTS_TO_JUDGE = 5;
/** Topics tried in one article run before giving up on the round. */
export const MAX_TOPIC_TRIES = 4;
/** A free first article tries fewer candidates: it has a ten minute promise, and the weakest one is written anyway. */
export const FREE_TOPIC_TRIES = 2;
/** After a round where every candidate was skipped, the hourly scheduler leaves that site alone for this many hours. */
export const EXHAUSTED_COOLDOWN_HOURS = 6;
/** A skipped query is not suggested again for this many days. */
export const SKIP_MEMORY_DAYS = 30;

/** Always strong, whatever the Tranco list says (it also covers the case where the list could not be downloaded). */
export const ALWAYS_STRONG: string[] = [
  "g2.com", "capterra.com", "getapp.com", "softwareadvice.com", "trustradius.com", "trustpilot.com", "gartner.com", "producthunt.com",
  "openai.com", "chatgpt.com", "google.com", "anthropic.com", "claude.ai", "microsoft.com", "apple.com", "amazon.com", "github.com", "stackoverflow.com",
  "wikipedia.org", "reddit.com", "quora.com", "youtube.com", "medium.com", "linkedin.com", "forbes.com", "nytimes.com", "cnet.com", "pcmag.com", "techradar.com",
  "zapier.com", "hubspot.com", "semrush.com", "ahrefs.com", "moz.com", "searchenginejournal.com", "searchengineland.com", "backlinko.com", "neilpatel.com", "wordstream.com",
  "shopify.com", "wix.com", "squarespace.com", "wordpress.org", "wordpress.com", "mailchimp.com", "salesforce.com", "adobe.com", "canva.com", "notion.so",
  "surferseo.com", "jasper.ai", "frase.io", "koala.sh", "outrank.so", "seo.ai",
];
/** Government and university domains are always strong. */
export const STRONG_TLD = /\.(gov|edu|mil)(\.[a-z]{2})?$/;

/** Hosts where the subdomain is somebody's own small site, so the parent's rank says nothing about it. */
export const TENANT_HOSTS: string[] = [
  "netlify.app", "vercel.app", "github.io", "gitlab.io", "pages.dev", "workers.dev", "herokuapp.com", "onrender.com", "fly.dev", "web.app", "firebaseapp.com",
  "blogspot.com", "wixsite.com", "weebly.com", "webflow.io", "framer.website", "carrd.co", "notion.site", "substack.com", "beehiiv.com", "ghost.io", "hashnode.dev",
];

/** Words that are never a company name when matching a result's domain to the query ("best crm tools"). */
export const QUERY_STOPWORDS = new Set([
  "best", "top", "free", "cheap", "online", "software", "tool", "tools", "app", "apps", "ai", "seo", "blog", "blogs", "blogging", "writer", "writing", "content",
  "alternative", "alternatives", "vs", "versus", "review", "reviews", "pricing", "price", "cost", "how", "what", "why", "does", "with", "for", "the", "and", "from",
  "your", "small", "business", "guide", "list", "platform", "automatic", "automation", "generator", "marketing", "tips", "examples",
]);

export type Competitor = {
  name: string;
  /** Domains that are this company's own. They count as strong in a SERP for a query about it. */
  domains: string[];
  /** Lowercase spellings that mean this company in a topic or search (matched on word boundaries). */
  names: string[];
};

/**
 * "[competitor] alternatives" topics blocked on Paperboy's own site while its authority is low (SPEC: SEO and GEO for
 * paperboyseo.com itself). Posts that already exist stay; no new ones are written.
 */
export const BLOCKED_ALTERNATIVES: Competitor[] = [
  { name: "Surfer", domains: ["surferseo.com"], names: ["surfer seo", "surferseo", "surfer"] },
  { name: "Jasper", domains: ["jasper.ai"], names: ["jasper ai", "jasper"] },
  { name: "Koala", domains: ["koala.sh"], names: ["koala ai", "koala writer", "koala"] },
  { name: "Outrank", domains: ["outrank.so"], names: ["outrank.so", "outrank"] },
  { name: "Frase", domains: ["frase.io"], names: ["frase.io", "frase"] },
  { name: "SEO.AI", domains: ["seo.ai"], names: ["seo.ai", "seo ai"] },
];

/** Small-tool comparisons that stay allowed (and are updated monthly). Listed so the gate also treats their own sites as strong in their own SERP. */
export const ALLOWED_ALTERNATIVES: Competitor[] = [
  { name: "Arvow", domains: ["arvow.com"], names: ["arvow"] },
  { name: "Abun", domains: ["abun.com"], names: ["abun"] },
  { name: "RankYak", domains: ["rankyak.com"], names: ["rankyak", "rank yak"] },
  { name: "RightBlogger", domains: ["rightblogger.com"], names: ["rightblogger", "right blogger"] },
  { name: "SEObot", domains: ["seobotai.com"], names: ["seobot", "seo bot"] },
  { name: "BoltSEO", domains: ["boltseo.ai"], names: ["boltseo", "bolt seo"] },
];

/** Words that make a topic an "alternatives" topic. Plain "vs" is not here: the "Paperboy vs X" pages stay. */
export const ALTERNATIVE_TERMS = ["alternative", "alternatives", "instead of", "replacement", "replacements", "sites like", "tools like", "apps like", "similar to"];

/**
 * The blocklist lifts when Paperboy's own domain authority is above this (SPEC says 20). The number comes from
 * OWN_SITE_AUTHORITY, set by hand from whatever authority tool the owner trusts; unset counts as 0, i.e. still blocked.
 */
export const OWN_AUTHORITY_UNLOCK = 20;
export const ownSiteAuthority = () => Number(process.env.OWN_SITE_AUTHORITY) || 0;

