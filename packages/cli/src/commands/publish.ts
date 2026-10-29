import type { Context } from '../context.js';
import { CliError } from '../errors.js';

export async function publish(ctx: Context): Promise<number> {
  const { out, flags } = ctx;
  const id = ctx.args[0];
  if (!id) throw new CliError('usage', 'Usage: paperboy publish <article-id>');

  if (ctx.deps.interactive && !flags.yes && !out.json) {
    const ok = await ctx.deps.confirm(`Publish article ${id} now?`);
    if (!ok) throw new CliError('cancelled', 'Cancelled. Nothing was published.');
  }

  const { data } = await ctx.client().post<{ published: boolean; url?: string }>(
    `/api/v1/articles/${encodeURIComponent(id)}/publish`,
    {},
  );
  out.result('publish', data, () => {
    if (data.published) out.line(`${out.style.green('Published')}${data.url ? `: ${data.url}` : ''}`);
    else out.line(`${out.style.yellow('Not published.')} The article was not published; check the fact-check verdict with \`paperboy status\`.`);
  });
  return data.published ? 0 : 1;
}
