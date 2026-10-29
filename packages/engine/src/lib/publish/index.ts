// Step 5: publish. One adapter per method; each can test its connection and publish or update an article.
import crypto from "node:crypto";
import { appUrl, BRAND } from "@/config/brand";
import { sql } from "@/lib/db";
import { ownSiteId } from "@/lib/own-blog";
import { faqHtml, schemaScript } from "@/lib/markdown";
import type { ArticleRow, SiteRow } from "@/lib/types";

export type Secrets = { wp_app_password?: string | null; ghost_admin_key?: string | null; webhook_secret?: string | null };
export type PublishResult = { url: string; externalId?: string | null; note?: string };
export type TestResult = { ok: boolean; message: string };

export async function secretsFor(siteId: string): Promise<Secrets> {
  const [row] = await sql()`select wp_app_password, ghost_admin_key, webhook_secret from site_secrets where site_id = ${siteId}`;
  return (row as Secrets) ?? {};
}

/**
 * Where the hosted blog lives: the customer's subdomain once DNS is live, otherwise our path-based address.
 * Paperboy's own marketing site (OWN_SITE_ID) lives at /blog on the app domain, so article links, schema and IndexNow use that.
 */
export function hostedBase(site: Pick<SiteRow, "id" | "blog_host" | "blog_host_status" | "slug">): string {
  if (site.id && site.id === ownSiteId()) return appUrl("/blog");
  return site.blog_host && site.blog_host_status === "live" ? `https://${site.blog_host}` : appUrl(`/b/${site.slug}`);
}

export function articleUrl(site: SiteRow, slug: string): string {
  switch (site.publish_method) {
    case "hosted":
      return `${hostedBase(site)}/${slug}`;
    case "prompt":
      return `${(site.publish_config.blog_base_url || `${site.url}/blog`).replace(/\/+$/, "")}/${slug}`;
    default:
      return ""; // the platform tells us
  }
}

const fullHtml = (a: ArticleRow) => `${a.body_html ?? ""}\n${faqHtml(a.faq ?? [])}`;

// ---------- WordPress ----------

function wpAuth(user: string, pass: string) {
  return `Basic ${Buffer.from(`${user}:${pass.replace(/\s+/g, "")}`).toString("base64")}`;
}
const wpBase = (u: string) => u.replace(/\/+$/, "").replace(/\/wp-admin.*$/, "");

export async function testWordPress(url: string, user: string, pass: string): Promise<TestResult> {
  try {
    const r = await fetch(`${wpBase(url)}/wp-json/wp/v2/users/me?context=edit`, { headers: { Authorization: wpAuth(user, pass) }, signal: AbortSignal.timeout(15_000) });
    if (r.status === 401 || r.status === 403)
      return { ok: false, message: "WordPress turned down the username or application password. Check both, and make sure the password is an application password (Users, Profile, Application passwords), not your login password." };
    if (r.status === 404) return { ok: false, message: "That site does not have the WordPress REST API turned on at /wp-json. Check the address, or ask your host whether a security plugin blocks it." };
    if (!r.ok) return { ok: false, message: `WordPress answered with an error (HTTP ${r.status}). Try again in a minute.` };
    const me = await r.json();
    const caps = me?.capabilities ?? {};
    if (!caps.publish_posts) return { ok: false, message: `Connected as ${me?.name ?? user}, but that user cannot publish posts. Use an Editor or Administrator account.` };
    return { ok: true, message: `Connected as ${me?.name ?? user}. Articles will publish to ${wpBase(url)}.` };
  } catch {
    return { ok: false, message: "We could not reach that address. Check the spelling and that the site is online." };
  }
}

async function publishWordPress(site: SiteRow, a: ArticleRow, s: Secrets, existingId?: string | null): Promise<PublishResult> {
  const cfg = site.publish_config;
  if (!cfg.wp_url || !cfg.wp_user || !s.wp_app_password) throw new Error("WordPress is not connected. Open Publishing and connect it again.");
  const body = {
    title: a.title,
    content: `${fullHtml(a)}\n${schemaScript(a.schema_ld)}`,
    excerpt: a.meta_description ?? a.excerpt,
    slug: a.slug,
    status: "publish",
  };
  const r = await fetch(`${wpBase(cfg.wp_url)}/wp-json/wp/v2/posts${existingId ? `/${existingId}` : ""}`, {
    method: "POST",
    headers: { Authorization: wpAuth(cfg.wp_user, s.wp_app_password), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`WordPress did not accept the post: ${j?.message ?? `HTTP ${r.status}`}`);
  return { url: j.link, externalId: String(j.id) };
}

// ---------- Ghost ----------

function ghostToken(adminKey: string): string {
  const [id, secret] = adminKey.trim().split(":");
  if (!id || !secret) throw new Error("That Ghost key does not look right. It should be the Admin API key, two parts separated by a colon.");
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "HS256", typ: "JWT", kid: id })}.${b64({ iat: now, exp: now + 300, aud: "/admin/" })}`;
  const sig = crypto.createHmac("sha256", Buffer.from(secret, "hex")).update(unsigned).digest("base64url");
  return `${unsigned}.${sig}`;
}
const ghostBase = (u: string) => u.replace(/\/+$/, "").replace(/\/ghost.*$/, "");

export async function testGhost(url: string, key: string): Promise<TestResult> {
  try {
    const r = await fetch(`${ghostBase(url)}/ghost/api/admin/site/`, { headers: { Authorization: `Ghost ${ghostToken(key)}`, "Accept-Version": "v5.0" }, signal: AbortSignal.timeout(15_000) });
    if (r.status === 401 || r.status === 403) return { ok: false, message: "Ghost turned down that key. Copy the Admin API key from Settings, Integrations, then a custom integration." };
    if (!r.ok) return { ok: false, message: `Ghost answered with an error (HTTP ${r.status}). Check the address points at your Ghost site.` };
    const j = await r.json();
    return { ok: true, message: `Connected to ${j?.site?.title ?? "your Ghost site"}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error && e.message.includes("Ghost key") ? e.message : "We could not reach that address. Check the spelling and that the site is online." };
  }
}

async function publishGhost(site: SiteRow, a: ArticleRow, s: Secrets, existingId?: string | null): Promise<PublishResult> {
  const cfg = site.publish_config;
  if (!cfg.ghost_url || !s.ghost_admin_key) throw new Error("Ghost is not connected. Open Publishing and connect it again.");
  const base = `${ghostBase(cfg.ghost_url)}/ghost/api/admin/posts/`;
  const headers = { Authorization: `Ghost ${ghostToken(s.ghost_admin_key)}`, "Content-Type": "application/json", "Accept-Version": "v5.0" };
  const post: Record<string, unknown> = {
    title: a.title, html: fullHtml(a), slug: a.slug, status: "published",
    custom_excerpt: (a.excerpt ?? "").slice(0, 300), meta_title: a.meta_title, meta_description: a.meta_description,
    codeinjection_head: schemaScript(a.schema_ld),
  };
  let url = `${base}?source=html`;
  let method = "POST";
  if (existingId) {
    const cur = await fetch(`${base}${existingId}/`, { headers }).then((r) => r.json()).catch(() => null);
    post.updated_at = cur?.posts?.[0]?.updated_at;
    url = `${base}${existingId}/?source=html`;
    method = "PUT";
  }
  const r = await fetch(url, { method, headers, body: JSON.stringify({ posts: [post] }), signal: AbortSignal.timeout(30_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Ghost did not accept the post: ${j?.errors?.[0]?.message ?? `HTTP ${r.status}`}`);
  return { url: j.posts[0].url, externalId: j.posts[0].id };
}

// ---------- Webhook ----------

export function webhookPayload(site: SiteRow, a: ArticleRow, event: "article.published" | "article.updated" | "test") {
  return {
    event,
    sent_at: new Date().toISOString(),
    site: { id: site.id, url: site.url },
    article: event === "test" ? null : {
      id: a.id, title: a.title, slug: a.slug, meta_title: a.meta_title, meta_description: a.meta_description, excerpt: a.excerpt,
      html: a.body_html, markdown: a.body_md, faq: a.faq, faq_html: faqHtml(a.faq ?? []), schema_json_ld: a.schema_ld,
      sources: a.sources, published_at: a.published_at,
    },
  };
}

async function postWebhook(url: string, secret: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Paperboy-Signature": `sha256=${sig}`, "User-Agent": `${BRAND.name}-Webhook/1.0` },
    body,
    signal: AbortSignal.timeout(20_000),
  });
}

export async function testWebhook(url: string, secret: string, site: SiteRow): Promise<TestResult> {
  try {
    const r = await postWebhook(url, secret, webhookPayload(site, {} as ArticleRow, "test"));
    return r.ok ? { ok: true, message: `Your endpoint answered ${r.status}. Articles will be sent there.` } : { ok: false, message: `Your endpoint answered HTTP ${r.status}. It must answer with a 2xx status.` };
  } catch {
    return { ok: false, message: "We could not reach that address. Check it is public and uses https." };
  }
}

async function publishWebhook(site: SiteRow, a: ArticleRow, s: Secrets, update: boolean): Promise<PublishResult> {
  const url = site.publish_config.webhook_url;
  if (!url || !s.webhook_secret) throw new Error("The webhook is not set up. Open Publishing and add your endpoint.");
  const r = await postWebhook(url, s.webhook_secret, webhookPayload(site, a, update ? "article.updated" : "article.published"));
  if (!r.ok) throw new Error(`Your webhook answered HTTP ${r.status}.`);
  const j = await r.json().catch(() => ({}));
  return { url: typeof j?.url === "string" ? j.url : a.published_url ?? "", externalId: j?.id ? String(j.id) : null };
}

// ---------- dispatch ----------

export async function publishArticle(site: SiteRow, a: ArticleRow, existing?: { externalId?: string | null; url?: string | null }): Promise<PublishResult> {
  const s = await secretsFor(site.id);
  switch (site.publish_method) {
    case "hosted":
    case "prompt":
      return { url: existing?.url || articleUrl(site, a.slug!) };
    case "wordpress":
      return publishWordPress(site, a, s, existing?.externalId);
    case "ghost":
      return publishGhost(site, a, s, existing?.externalId);
    case "webhook":
      return publishWebhook(site, a, s, !!existing);
  }
}

// ---------- IndexNow ----------

/** Tells Bing, Yandex, Seznam and other IndexNow engines about a new or changed URL. Google reads the sitemap. */
export async function pingIndexNow(site: SiteRow, url: string): Promise<string> {
  if (!url) return "No address to submit.";
  let host = "";
  try { host = new URL(url).host; } catch { return "No address to submit."; }
  // We can only prove ownership on hosts that serve our key file: the hosted blog, our own domain, and paste-prompt sites.
  if (!["hosted", "prompt"].includes(site.publish_method)) return "Submitted through the sitemap (IndexNow needs a key file on your site, which this publishing method does not add).";
  const keyLocation = `${url.split("/").slice(0, 3).join("/")}/${site.indexnow_key}.txt`;
  try {
    const r = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host, key: site.indexnow_key, keyLocation, urlList: [url] }),
      signal: AbortSignal.timeout(15_000),
    });
    return r.ok || r.status === 202 ? "Submitted to IndexNow." : `IndexNow answered ${r.status}; the sitemap still lists the page.`;
  } catch {
    return "IndexNow could not be reached; the sitemap still lists the page.";
  }
}
