import { intFlag } from '../args.js';
import type { Context } from '../context.js';
import { num } from '../output.js';
import { resolveSiteId } from '../site.js';

export interface Topic {
  id: string;
  title: string;
  query?: string;
  reason?: string;
  signals?: { impressions?: number; position?: number; serp_gate?: unknown };
}

export function describeSignals(signals: Topic['signals']): string {
  if (!signals) return '';
  const parts: string[] = [];
  if (typeof signals.impressions === 'number') parts.push(`${num(signals.impressions)} impressions`);
  if (typeof signals.position === 'number') parts.push(`position ${signals.position.toFixed(1)}`);
  const gate = signals.serp_gate;
  if (gate !== undefined && gate !== null) {
    const text = typeof gate === 'boolean' ? (gate ? 'pass' : 'blocked') : typeof gate === 'string' ? gate : JSON.stringify(gate);
    parts.push(`serp gate: ${text}`);
  }
  return parts.join(', ');
}

export async function topics(ctx: Context): Promise<number> {
  const { out } = ctx;
  const n = intFlag(ctx.flags.n, 'n', 5, 50);
  const site = await resolveSiteId(ctx);
  const { data } = await ctx.client().post<{ topics?: Topic[] }>(`/api/v1/sites/${encodeURIComponent(site)}/topics`, { n });
  const list = data.topics ?? [];

  out.result('topics', data, () => {
    if (list.length === 0) {
      out.line('No topics yet. Search Console may still be collecting data for this site.');
      return;
    }
    list.forEach((t, i) => {
      out.line(`${out.style.bold(`${i + 1}. ${t.title}`)}  ${out.style.dim(`[${t.id}]`)}`);
      if (t.query) out.line(`   query: ${t.query}`);
      if (t.reason) out.line(`   why: ${t.reason}`);
      const signals = describeSignals(t.signals);
      if (signals) out.line(`   signals: ${signals}`);
      out.line();
    });
    out.line(`Write one with: paperboy write --topic ${list[0]?.id ?? '<id>'}`);
  });
  return 0;
}
