import type { Context } from '../context.js';
import { CliError } from '../errors.js';
import { num } from '../output.js';
import { resolveSiteId } from '../site.js';

interface Me {
  owner?: string | { email?: string; name?: string; id?: string };
  email?: string;
  credits?: { enabled?: boolean; balance?: number };
}

interface SiteDetail {
  id: string;
  domain: string;
  gsc_connected?: boolean;
  publish_method?: string;
  articles?: { id: string; title: string; status?: string; url?: string | null }[];
}

function ownerLabel(me: Me): string {
  if (typeof me.owner === 'string') return me.owner;
  return me.owner?.email ?? me.owner?.name ?? me.owner?.id ?? me.email ?? 'unknown';
}

export async function status(ctx: Context): Promise<number> {
  const { out } = ctx;
  const api = ctx.client();
  const { data: me } = await api.get<Me>('/api/v1/me');

  let site: SiteDetail | null = null;
  try {
    const id = await resolveSiteId(ctx);
    const res = await api.get<{ site: SiteDetail }>(`/api/v1/sites/${encodeURIComponent(id)}`);
    site = res.data.site;
  } catch (err) {
    if (!(err instanceof CliError && err.code === 'no_site')) throw err;
  }

  out.result('status', { me, site }, () => {
    const s = out.style;
    out.line(`${s.bold('owner:')}    ${ownerLabel(me)}`);
    if (me.credits?.enabled) out.line(`${s.bold('credits:')}  ${num(me.credits.balance)}`);
    if (!site) {
      out.line('site:     none yet. Run `paperboy connect https://yoursite.com` to add one.');
      return;
    }
    out.line(`${s.bold('site:')}     ${site.domain} (${site.id})`);
    out.line(`${s.bold('publish:')}  ${site.publish_method ?? 'not configured'}`);
    out.line(`${s.bold('gsc:')}      ${site.gsc_connected ? s.green('connected') : s.yellow('not connected')}`);
    const articles = site.articles ?? [];
    if (articles.length) {
      out.line(s.bold('last articles:'));
      for (const a of articles) {
        out.line(`  ${a.title}  ${s.dim(`[${a.id}] ${a.status ?? ''}${a.url ? ` ${a.url}` : ''}`.trimEnd())}`);
      }
    } else {
      out.line('last articles: none yet');
    }
  });
  return 0;
}
