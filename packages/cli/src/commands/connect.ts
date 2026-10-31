import type { ApiClient } from '../api.js';
import { maskKey, updateConfig, configPath } from '../config.js';
import type { Context } from '../context.js';
import { ApiError, CliError } from '../errors.js';

interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval?: number;
  expires_in?: number;
}

interface SiteInfo {
  id: string;
  domain: string;
  gsc_connected?: boolean;
}

const GSC_POLL_MS = 3000;
const GSC_TIMEOUT_MS = 5 * 60_000;

function normalizeBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError('usage', `"${value}" is not a valid URL. Example: http://localhost:3000`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError('usage', `"${value}" must start with http:// or https://`);
  }
  return value.replace(/\/+$/, '');
}

function normalizeSiteUrl(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

export async function connect(ctx: Context): Promise<number> {
  const { flags, out, env } = ctx;
  const baseUrl = normalizeBase(flags['self-host'] ?? ctx.settings.baseUrl);
  const shouldOpen = !out.json && !flags['no-open'] && !env['PAPERBOY_NO_OPEN'];
  const open = (url: string) => {
    if (shouldOpen) ctx.deps.open(url);
  };

  let apiKey: string;
  let usedDeviceFlow = false;
  if (flags['api-key']) {
    apiKey = flags['api-key'];
    await verifyKey(ctx.client({ baseUrl, apiKey }), baseUrl);
  } else {
    apiKey = await deviceFlow(ctx, ctx.client({ baseUrl, apiKey: undefined }), open);
    usedDeviceFlow = true;
  }

  const file = updateConfig(env, { base_url: baseUrl, api_key: apiKey });
  const api = ctx.client({ baseUrl, apiKey });
  const data: Record<string, unknown> = {
    base_url: baseUrl,
    api_key_preview: maskKey(apiKey),
    config_path: file,
    auth: usedDeviceFlow ? 'device_flow' : 'api_key',
  };
  out.prompt(`${out.style.green('Signed in.')} Saved key ${maskKey(apiKey)} to ${configPath(env)}`);

  const siteArg = ctx.args[0];
  if (siteArg) {
    const site = await addSite(ctx, api, normalizeSiteUrl(siteArg), open, data);
    data['site'] = site;
  }

  out.result('connect', data, () => {
    if (data['site']) {
      const site = data['site'] as SiteInfo;
      out.line(`Site: ${site.domain} (${site.id})`);
      out.line(`Search Console: ${site.gsc_connected ? out.style.green('connected') : out.style.yellow('not connected yet')}`);
    }
    out.line('Next: `paperboy topics` to see what to write.');
  });
  return 0;
}

async function verifyKey(api: ApiClient, baseUrl: string): Promise<void> {
  try {
    await api.get('/api/v1/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      throw new CliError('invalid_api_key', `${baseUrl} rejected that API key.`, 401);
    }
    throw err;
  }
}

async function deviceFlow(ctx: Context, api: ApiClient, open: (url: string) => void): Promise<string> {
  const { out } = ctx;
  const { data: code } = await api.post<DeviceCode>('/api/v1/device/code', { client: 'paperboy-cli' }, { auth: false });
  const url = code.verification_uri_complete ?? code.verification_uri;

  out.prompt('To sign in, open this page in your browser:');
  out.prompt(`  ${out.style.cyan(url)}`);
  out.prompt(`and confirm this code: ${out.style.bold(code.user_code)}`);
  out.prompt('Waiting for approval...');
  open(url);

  let intervalMs = Math.max(0, (code.interval ?? 5) * 1000);
  const expiresMs = (code.expires_in ?? 600) * 1000;
  let waited = 0;
  for (;;) {
    if (waited >= expiresMs) throw expired();
    await ctx.deps.sleep(intervalMs);
    waited += intervalMs;
    try {
      const { data } = await api.post<{ api_key?: string }>('/api/v1/device/token', { device_code: code.device_code }, { auth: false });
      if (!data.api_key) throw new CliError('bad_response', 'The server approved the sign-in but returned no API key.');
      return data.api_key;
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      switch (err.code) {
        case 'authorization_pending':
          break;
        case 'slow_down':
          intervalMs += 5000;
          break;
        case 'expired_token':
          throw expired();
        case 'access_denied':
          throw new CliError('access_denied', 'Sign-in was denied in the browser. Run `paperboy connect` to try again.');
        default:
          throw err;
      }
    }
  }
}

function expired(): CliError {
  return new CliError('expired_token', 'The sign-in code expired before it was approved. Run `paperboy connect` again.');
}

async function addSite(
  ctx: Context,
  api: ApiClient,
  siteUrl: string,
  open: (url: string) => void,
  data: Record<string, unknown>,
): Promise<SiteInfo> {
  const { out, env } = ctx;
  const created = await api.post<{ site: SiteInfo; gsc_connect_url?: string }>('/api/v1/sites', { url: siteUrl });
  let site = created.data.site;
  updateConfig(env, { default_site: site.id });
  out.prompt(`Added ${out.style.bold(site.domain)} (${site.id}) and set it as your default site.`);
  if (site.gsc_connected) return site;

  let link = created.data.gsc_connect_url;
  if (!link) {
    try {
      const res = await api.post<{ url: string }>(`/api/v1/sites/${encodeURIComponent(site.id)}/gsc/connect`, {});
      link = res.data.url;
    } catch (err) {
      // A self-host without its own Google OAuth client can still write and fact check, just without Search Console data.
      if (err instanceof CliError && err.code === 'gsc_not_configured') {
        out.prompt('Search Console is not set up on this server (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET). Skipping it; see docs/self-host.md.');
        return site;
      }
      throw err;
    }
  }
  data['gsc_connect_url'] = link;
  out.prompt('Connect Google Search Console so Paperboy can read your data:');
  out.prompt(`  ${out.style.cyan(link)}`);
  open(link);

  if (ctx.flags['no-wait']) return site;

  out.prompt('Waiting for Search Console authorization...');
  let waited = 0;
  while (!site.gsc_connected) {
    if (waited >= GSC_TIMEOUT_MS) {
      throw new CliError(
        'gsc_timeout',
        'Search Console was not connected within 5 minutes. Open the link above, then run `paperboy status`.',
      );
    }
    await ctx.deps.sleep(GSC_POLL_MS);
    waited += GSC_POLL_MS;
    const res = await api.get<{ site: SiteInfo }>(`/api/v1/sites/${encodeURIComponent(site.id)}`);
    site = res.data.site;
  }
  out.prompt(out.style.green('Search Console connected.'));
  return site;
}
