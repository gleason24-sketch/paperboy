// SPDX-License-Identifier: AGPL-3.0-only
// Outgoing email through Resend (https://resend.com). Without RESEND_API_KEY, emails are skipped and logged.
import { appUrl, BRAND } from "@/config/brand";
import { escapeHtml } from "@/lib/util";

export async function sendEmail(to: string, subject: string, html: string, text: string): Promise<{ sent: boolean; reason?: string }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn(`[email skipped: RESEND_API_KEY not set] to=${to} subject=${subject}`);
    return { sent: false, reason: "RESEND_API_KEY not set" };
  }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: BRAND.emailFrom, to: [to], subject, html, text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) {
    const reason = await r.text().catch(() => String(r.status));
    console.error("email failed", r.status, reason);
    return { sent: false, reason };
  }
  return { sent: true };
}

/** A plain email layout: logo, one column, the product's type and colors, footer with the legal owner. */
export function layout(title: string, inner: string, opts: { unsubscribe?: string } = {}) {
  return `<!doctype html><html><body style="margin:0;background:#F2F4F6;font-family:Helvetica,Arial,sans-serif;color:#16202B">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #D9DEE4">
<tr><td style="padding:24px 28px;border-bottom:1px solid #16202B"><img src="${appUrl(BRAND.logo.wordmark)}" alt="${escapeHtml(BRAND.name)}" height="28" style="display:block"></td></tr>
<tr><td style="padding:28px">
<h1 style="font-family:Georgia,serif;font-weight:500;font-size:26px;line-height:1.2;margin:0 0 16px">${escapeHtml(title)}</h1>
${inner}
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #D9DEE4;font-size:12px;color:#5A6573">${escapeHtml(BRAND.name)} is operated by ${escapeHtml(BRAND.legalOwner)}${BRAND.postalAddress ? `, ${escapeHtml(BRAND.postalAddress)}` : ""}. ${opts.unsubscribe ? `<a href="${escapeHtml(opts.unsubscribe)}" style="color:#5A6573">Unsubscribe from these emails</a>` : `<a href="${appUrl("/app/account")}" style="color:#5A6573">Email settings</a>`}</td></tr>
</table></td></tr></table></body></html>`;
}

export const button = (href: string, label: string) =>
  `<a href="${escapeHtml(href)}" style="display:inline-block;background:#1F5F9E;color:#fff;text-decoration:none;padding:12px 18px;border-radius:4px;font-weight:600">${escapeHtml(label)}</a>`;
export const p = (s: string) => `<p style="font-size:15px;line-height:1.55;margin:0 0 14px">${s}</p>`;
