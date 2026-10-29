import { randomUUID } from 'node:crypto';
import type { Context } from '../context.js';
import { CliError } from '../errors.js';
import { pollJob } from '../jobs.js';
import { resolveSiteId } from '../site.js';

export interface Check {
  claim: string;
  status: string;
  source?: string;
  note?: string;
}

export interface Article {
  id: string;
  title: string;
  status: string;
  url?: string | null;
  verdict?: { pass?: boolean; score?: number; checks?: Check[] };
}

export function summarizeChecks(checks: Check[]): { verified: number; held: number; other: number } {
  let verified = 0;
  let held = 0;
  let other = 0;
  for (const c of checks) {
    if (c.status === 'verified') verified++;
    else if (c.status === 'held') held++;
    else other++;
  }
  return { verified, held, other };
}

export async function write(ctx: Context): Promise<number> {
  const { out, flags } = ctx;
  const api = ctx.client();
  const site = await resolveSiteId(ctx);

  // Free text always has a space in it; ids never do.
  const body: Record<string, unknown> = { publish: Boolean(flags.publish) };
  if (flags.topic !== undefined) {
    if (flags.topic.trim() === '') throw new CliError('usage', '--topic needs a topic id or some text.');
    body[/\s/.test(flags.topic.trim()) ? 'topic' : 'topic_id'] = flags.topic.trim();
  }

  if (flags.publish && ctx.deps.interactive && !flags.yes && !out.json) {
    const ok = await ctx.deps.confirm('Publish automatically when the fact-check passes?');
    if (!ok) throw new CliError('cancelled', 'Cancelled. Re-run without --publish to keep it as a draft.');
  }

  const wait = flags.wait ?? (flags['no-wait'] ? false : ctx.deps.interactive);
  const { data: started } = await api.post<{ job_id: string; article_id?: string }>(
    `/api/v1/sites/${encodeURIComponent(site)}/articles`,
    body,
    { idempotencyKey: randomUUID() },
  );
  out.info(`Started job ${started.job_id}.`);

  if (!wait) {
    out.result('write', started, () => {
      out.line(`The article is being written. Check on it with: paperboy status`);
    });
    return 0;
  }

  const job = await pollJob(ctx, api, started.job_id);
  const articleId = job.article_id ?? started.article_id;
  if (!articleId) throw new CliError('bad_response', 'The job finished but no article id was returned.');
  const raw = await api.get<Article | { article: Article }>(`/api/v1/articles/${encodeURIComponent(articleId)}`);
  const article: Article = 'article' in raw.data ? raw.data.article : raw.data;

  out.result('write', { job_id: started.job_id, article }, () => {
    const checks = article.verdict?.checks ?? [];
    const counts = summarizeChecks(checks);
    out.line();
    out.line(out.style.bold(article.title));
    out.line(`status: ${article.status}`);
    if (article.url) out.line(`url: ${article.url}`);
    if (article.verdict) {
      const verdict = article.verdict.pass ? out.style.green('PASS') : out.style.red('FAIL');
      const score = typeof article.verdict.score === 'number' ? ` (score ${article.verdict.score})` : '';
      out.line(`fact-check: ${verdict}${score}: ${counts.verified} claims verified, ${counts.held} held`);
      for (const c of checks.filter((x) => x.status !== 'verified')) {
        out.line(`  ${out.style.yellow(c.status.toUpperCase())} ${c.claim}`);
      }
    }
    if (!article.url) out.line(`Publish it with: paperboy publish ${article.id}`);
  });
  return 0;
}
