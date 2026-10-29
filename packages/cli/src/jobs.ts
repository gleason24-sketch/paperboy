import type { ApiClient } from './api.js';
import type { Context } from './context.js';
import { CliError } from './errors.js';

export interface Job {
  status: 'queued' | 'running' | 'done' | 'failed';
  step?: string;
  article_id?: string;
  result?: unknown;
  error?: string | { code?: string; message?: string };
}

function jobErrorMessage(error: Job['error']): string {
  if (!error) return 'The job failed.';
  if (typeof error === 'string') return error;
  return error.message ?? error.code ?? 'The job failed.';
}

/**
 * Poll GET /api/v1/jobs/{id} until it is done or failed. Time is counted from the
 * sleeps themselves so the loop is deterministic when `sleep` is stubbed in tests.
 */
export async function pollJob(
  ctx: Context,
  api: ApiClient,
  jobId: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<Job> {
  const intervalMs = opts.intervalMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  let waited = 0;
  let lastStep: string | undefined;
  for (;;) {
    const { data: job } = await api.get<Job>(`/api/v1/jobs/${encodeURIComponent(jobId)}`);
    if (job.step && job.step !== lastStep) {
      lastStep = job.step;
      ctx.out.info(ctx.out.style.dim(`  ${job.step}`));
    }
    if (job.status === 'done') return job;
    if (job.status === 'failed') throw new CliError('job_failed', jobErrorMessage(job.error));
    if (waited >= timeoutMs) {
      throw new CliError('job_timeout', `Job ${jobId} is still running. Check on it later with \`paperboy status\`.`);
    }
    await ctx.deps.sleep(intervalMs);
    waited += intervalMs;
  }
}
