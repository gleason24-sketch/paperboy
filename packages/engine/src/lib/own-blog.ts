// SPDX-License-Identifier: AGPL-3.0-only
/** The site row that is the operator's own marketing site, if any. Set OWN_SITE_ID to a site id; unset means none. */
export function ownSiteId(): string | null {
  return process.env.OWN_SITE_ID || null;
}
