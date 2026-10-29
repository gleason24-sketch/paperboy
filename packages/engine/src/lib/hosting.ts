// Hosted blogs on customer subdomains (blog.theirsite.com). The customer adds one CNAME record pointing at our Netlify
// site; we add their host as a domain alias on that Netlify site so Netlify serves it and issues the HTTPS certificate.
import { BRAND } from "@/config/brand";
import { sql } from "@/lib/db";
import type { SiteRow } from "@/lib/types";

const NETLIFY_API = "https://api.netlify.com/api/v1";

/** Adds the host to the Netlify site's domain aliases. Needs NETLIFY_AUTH_TOKEN (a personal access token). */
export async function registerBlogHost(host: string): Promise<string> {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const siteId = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  if (!token || !siteId) return "Note: automatic HTTPS setup is waiting on the NETLIFY_AUTH_TOKEN setting (see SETUP.md).";
  try {
    const cur = await fetch(`${NETLIFY_API}/sites/${siteId}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
    const aliases: string[] = cur.domain_aliases ?? [];
    if (aliases.includes(host)) return "";
    const r = await fetch(`${NETLIFY_API}/sites/${siteId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ domain_aliases: [...aliases, host] }),
    });
    return r.ok ? "" : `Note: we could not register the address with our host yet (HTTP ${r.status}); we will retry when you press Check.`;
  } catch {
    return "Note: we could not reach our host to register the address; we will retry when you press Check.";
  }
}

async function cnameOf(host: string): Promise<string[]> {
  const r = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=CNAME`, { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  return (j.Answer ?? []).map((a: { data: string }) => a.data.replace(/\.$/, "").toLowerCase());
}

export async function checkDns(site: SiteRow): Promise<{ ok: boolean; message: string }> {
  if (!site.blog_host) return { ok: false, message: "Add your blog address first." };
  const target = BRAND.blogCnameTarget.toLowerCase();
  let cnames: string[] = [];
  try { cnames = await cnameOf(site.blog_host); } catch { return { ok: false, message: "We could not look up DNS right now. Try again in a minute." }; }
  if (!cnames.includes(target)) {
    await sql()`update sites set blog_host_status = 'waiting_dns' where id = ${site.id}`;
    return {
      ok: false,
      message: cnames.length
        ? `${site.blog_host} points to ${cnames[0]}, not ${target}. Change the CNAME record's value to ${target}.`
        : `We do not see the CNAME record for ${site.blog_host} yet. DNS changes can take up to an hour. Check the name is "${site.blog_host.split(".")[0]}" and the value is ${target}.`,
    };
  }
  await registerBlogHost(site.blog_host);
  try {
    const r = await fetch(`https://${site.blog_host}/api/health`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (j?.app !== "paperboy") throw new Error("not ours");
  } catch {
    return { ok: false, message: "The DNS record is right. The HTTPS certificate is still being issued; this usually takes a few minutes. Press Check again soon." };
  }
  await sql()`update sites set blog_host_status = 'live' where id = ${site.id}`;
  // Articles published before the subdomain went live move to it (the old address redirects).
  if (site.publish_method === "hosted")
    await sql()`update articles set published_url = ${`https://${site.blog_host}/`} || slug where site_id = ${site.id} and status = 'published' and slug is not null`;
  return { ok: true, message: `Your blog is live at https://${site.blog_host}.` };
}
