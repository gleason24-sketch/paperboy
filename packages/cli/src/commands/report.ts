import { intFlag } from '../args.js';
import type { Context } from '../context.js';
import { fixed, num, padLeft, padRight, sparkline } from '../output.js';
import { resolveSiteId } from '../site.js';

interface Performance {
  days: number;
  totals: { clicks?: number; impressions?: number; position?: number; ctr?: number };
  daily?: { date: string; clicks: number; impressions: number }[];
}

export async function report(ctx: Context): Promise<number> {
  const { out, flags } = ctx;
  const days = intFlag(flags.days, 'days', 28, 365);
  const site = await resolveSiteId(ctx);
  const api = ctx.client();
  const base = `/api/v1/sites/${encodeURIComponent(site)}`;

  if (flags.markdown) {
    const { data } = await api.post<{ markdown: string; data?: unknown }>(`${base}/reports`, { days });
    out.result('report', data, () => out.line(data.markdown.replace(/\n+$/, '')));
    return 0;
  }

  const { data } = await api.get<Performance>(`${base}/performance`, { query: { days } });
  out.result('report', data, () => {
    const s = out.style;
    const t = data.totals ?? {};
    const daily = data.daily ?? [];
    const ctr =
      t.impressions && t.clicks !== undefined ? (t.clicks / t.impressions) * 100 : t.ctr !== undefined ? t.ctr * 100 : undefined;

    out.line(s.bold(`Last ${data.days ?? days} days`));
    out.line(`  clicks        ${num(t.clicks)}`);
    out.line(`  impressions   ${num(t.impressions)}`);
    out.line(`  avg position  ${fixed(t.position)}`);
    if (ctr !== undefined) out.line(`  ctr           ${fixed(ctr, 2)}%`);

    if (daily.length) {
      out.line();
      out.line(`clicks per day  ${sparkline(daily.map((d) => d.clicks))}`);
      out.line();
      out.line(s.dim(`${padRight('date', 12)}${padLeft('clicks', 8)}${padLeft('impressions', 13)}`));
      for (const d of daily.slice(-7)) {
        out.line(`${padRight(d.date, 12)}${padLeft(num(d.clicks), 8)}${padLeft(num(d.impressions), 13)}`);
      }
    }
  });
  return 0;
}
