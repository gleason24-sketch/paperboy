import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Context } from '../context.js';
import { CliError } from '../errors.js';
import { pollJob } from '../jobs.js';

export interface CheckResult {
  pass: boolean;
  claims_total?: number;
  claims_verified?: number;
  checks?: { claim: string; status: string; source?: string; note?: string }[];
}

function readText(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    const reason = err instanceof Error && 'code' in err ? String((err as NodeJS.ErrnoException).code) : 'unreadable';
    throw new CliError('file_error', `Could not read ${what} "${path}" (${reason}).`);
  }
}

export async function check(ctx: Context): Promise<number> {
  const { out, flags } = ctx;
  const target = ctx.args[0];
  if (!target) throw new CliError('usage', 'Usage: paperboy check <url|file.md> [--sources file]');

  const body: Record<string, unknown> = /^https?:\/\//i.test(target) ? { url: target } : { markdown: readText(target, 'file') };
  if (flags.sources) {
    body['sources'] = readText(flags.sources, 'sources file')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
  }

  const api = ctx.client({ timeoutMs: 120_000 });
  const res = await api.post<CheckResult | { job_id: string }>('/api/v1/fact-check', body, { idempotencyKey: randomUUID() });

  let result: CheckResult;
  if (res.status === 202 || 'job_id' in res.data) {
    const jobId = (res.data as { job_id: string }).job_id;
    out.info(`Fact-check queued (${jobId}).`);
    const job = await pollJob(ctx, api, jobId, { intervalMs: 2000 });
    result = (job.result ?? job) as CheckResult;
  } else {
    result = res.data as CheckResult;
  }

  const checks = result.checks ?? [];
  const total = result.claims_total ?? checks.length;
  const verified = result.claims_verified ?? checks.filter((c) => c.status === 'verified').length;

  out.result('check', result, () => {
    const s = out.style;
    out.line(`${result.pass ? s.green('PASS') : s.red('FAIL')}: ${verified} of ${total} claims verified`);
    for (const c of checks) {
      const label = c.status === 'verified' ? s.green('VERIFIED') : c.status === 'held' ? s.yellow('HELD') : s.red(c.status.toUpperCase());
      const extra = [c.note, c.source ? `source: ${c.source}` : undefined].filter(Boolean).join('; ');
      out.line(`  ${label} ${c.claim}${extra ? s.dim(` (${extra})`) : ''}`);
    }
  });
  return result.pass ? 0 : 1;
}
