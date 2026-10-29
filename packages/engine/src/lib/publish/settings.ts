// Saving a publishing method: validates, tests the connection, stores secrets server-side only.
import { sql } from "@/lib/db";
import { randomHex } from "@/lib/sign";
import type { SiteRow } from "@/lib/types";
import { normalizeUrl } from "@/lib/util";
import { testGhost, testWebhook, testWordPress, type TestResult } from "./index";

export type PublishInput = {
  method: SiteRow["publish_method"];
  blog_base_url?: string;
  wp_url?: string; wp_user?: string; wp_app_password?: string;
  ghost_url?: string; ghost_admin_key?: string;
  webhook_url?: string;
};

export const METHODS: SiteRow["publish_method"][] = ["hosted", "prompt", "wordpress", "ghost", "webhook"];

export async function savePublishing(site: SiteRow, input: PublishInput): Promise<TestResult> {
  const db = sql();
  if (!METHODS.includes(input.method)) return { ok: false, message: "Pick one of the publishing options." };
  const [secrets] = await db`select * from site_secrets where site_id = ${site.id}`;
  let config: Record<string, unknown> = { ...site.publish_config };
  let result: TestResult = { ok: true, message: "Saved." };

  if (input.method === "hosted") {
    result = { ok: true, message: "Articles will publish to your hosted blog." };
  } else if (input.method === "prompt") {
    const base = normalizeUrl(input.blog_base_url || `${site.url}/blog`);
    if (!base) return { ok: false, message: "Enter the address where your blog will live, like https://yoursite.com/blog." };
    config = { ...config, blog_base_url: base };
    result = { ok: true, message: "Saved. Paste the prompt into your site builder to add the blog." };
  } else if (input.method === "wordpress") {
    const url = normalizeUrl(input.wp_url || site.url);
    const pass = input.wp_app_password?.trim() || secrets?.wp_app_password;
    if (!url || !input.wp_user?.trim() || !pass) return { ok: false, message: "Enter your WordPress address, username and application password." };
    result = await testWordPress(url, input.wp_user.trim(), pass);
    if (!result.ok) return result;
    config = { ...config, wp_url: url, wp_user: input.wp_user.trim() };
    await db`update site_secrets set wp_app_password = ${pass}, updated_at = now() where site_id = ${site.id}`;
  } else if (input.method === "ghost") {
    const url = normalizeUrl(input.ghost_url || site.url);
    const key = input.ghost_admin_key?.trim() || secrets?.ghost_admin_key;
    if (!url || !key) return { ok: false, message: "Enter your Ghost address and Admin API key." };
    result = await testGhost(url, key);
    if (!result.ok) return result;
    config = { ...config, ghost_url: url };
    await db`update site_secrets set ghost_admin_key = ${key}, updated_at = now() where site_id = ${site.id}`;
  } else if (input.method === "webhook") {
    const url = normalizeUrl(input.webhook_url ?? "");
    if (!url || !url.startsWith("https://")) return { ok: false, message: "Enter an https address that accepts POST requests." };
    const secret = secrets?.webhook_secret || randomHex(24);
    await db`update site_secrets set webhook_secret = ${secret}, updated_at = now() where site_id = ${site.id}`;
    result = await testWebhook(url, secret, site);
    if (!result.ok) return result;
    config = { ...config, webhook_url: url };
  }
  await db`update sites set publish_method = ${input.method}, publish_config = ${db.json(config as never)} where id = ${site.id}`;
  return result;
}
