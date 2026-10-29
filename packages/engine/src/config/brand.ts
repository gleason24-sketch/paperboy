// SPDX-License-Identifier: AGPL-3.0-only
// Names, links and sender for a self-hosted instance. Everything comes from the environment, so a fork can rename it.

export const BRAND = {
  name: process.env.PAPERBOY_BRAND_NAME || "Paperboy",
  tagline: "Articles that rank, written and published for you, with every number checked.",
  domain: process.env.NEXT_PUBLIC_APP_DOMAIN || "localhost:3000",
  // The DNS target a customer points a blog subdomain at. Empty on a plain self-host (use your own reverse proxy).
  blogCnameTarget: process.env.NEXT_PUBLIC_BLOG_CNAME_TARGET || "",
  logo: { wordmark: "/brand/wordmark.png" },
  legalOwner: process.env.PAPERBOY_OPERATOR || "the operator of this instance",
  postalAddress: process.env.POSTAL_ADDRESS || "",
  supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "",
  emailFrom: process.env.EMAIL_FROM || "Paperboy <reports@localhost>",
} as const;

export const appUrl = (path = "") => {
  const base = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return `${base.replace(/\/+$/, "")}${path}`;
};
