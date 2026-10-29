import type { ApiClient } from './api.js';
import type { Context } from './context.js';
import { CliError } from './errors.js';

export interface SiteSummary {
  id: string;
  domain: string;
  gsc_connected?: boolean;
  [key: string]: unknown;
}

function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

async function listSites(api: ApiClient): Promise<SiteSummary[]> {
  const res = await api.get<{ sites?: SiteSummary[] }>('/api/v1/sites');
  return Array.isArray(res.data.sites) ? res.data.sites : [];
}

function describe(sites: SiteSummary[]): string {
  return sites.map((s) => `  ${s.domain} (${s.id})`).join('\n');
}

/**
 * Resolve the site id to operate on: --site (id or domain), then the saved default,
 * then the only site on the account.
 */
export async function resolveSiteId(ctx: Context): Promise<string> {
  const api = ctx.client();
  const wanted = ctx.settings.site;

  if (wanted) {
    // Domains always contain a dot and ids never do, so ids skip the lookup.
    if (!wanted.includes('.')) return wanted;
    const sites = await listSites(api);
    const target = normalizeDomain(wanted);
    const match = sites.find((s) => s.id === wanted || normalizeDomain(s.domain) === target);
    if (match) return match.id;
    throw new CliError(
      'site_not_found',
      `No site matches "${wanted}".` + (sites.length ? `\nYour sites:\n${describe(sites)}` : ' Run `paperboy connect https://yoursite.com` to add one.'),
    );
  }

  const sites = await listSites(api);
  const [only] = sites;
  if (sites.length === 1 && only) return only.id;
  if (sites.length === 0) {
    throw new CliError('no_site', 'No sites on this account yet. Run `paperboy connect https://yoursite.com` to add one.');
  }
  throw new CliError(
    'site_required',
    `More than one site on this account. Pick one with --site <id|domain>:\n${describe(sites)}`,
  );
}
