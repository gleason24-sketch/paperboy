// SPDX-License-Identifier: AGPL-3.0-only
// The self-host worker: runs planned articles and the recurring jobs.
//   every 15 s            claim planned articles and run them (two at a time)
//   hourly                runJob("schedule")   decide what each site is due, restart stuck articles
//   daily 06:15 UTC       runJob("gsc")        pull Search Console data
//   Mondays 13:00 UTC     runJob("weekly")     weekly report
//   (the rank loop starts per site at the end of the daily Search Console pull, in jobs.ts)
// Run it with `tsx src/server/worker.ts`. SIGTERM and SIGINT stop it gracefully.
import { pathToFileURL } from "node:url";
import { sql as realSql } from "@/lib/db";

type Row = Record<string, any>;
type Sql = (strings: TemplateStringsArray, ...values: any[]) => PromiseLike<Row[]>;

export type WorkerOptions = {
  sql?: () => Sql;
  runArticle?: (id: string) => Promise<void>;
  runJob?: (job: string, payload?: Record<string, unknown>) => Promise<unknown>;
  pollMs?: number;
  concurrency?: number;
  /** How long stop() waits for running articles before giving up (their locks expire and the scheduler restarts them). */
  graceMs?: number;
  /** Disable the recurring jobs (tests, or a second worker that only writes articles). */
  jobs?: boolean;
  log?: (line: string) => void;
  now?: () => number;
};

export type Worker = {
  /** Runs one poll cycle and resolves when the articles it started have been launched (not finished). */
  tick(): Promise<number>;
  running(): string[];
  stop(): Promise<void>;
};

const HOUR = 3600_000;

/** Milliseconds from `from` until the next time it is hh:mm UTC (and the given weekday, 0 = Sunday, when set). Never 0. */
export function msUntilUtc(from: number, hour: number, minute: number, weekday?: number): number {
  const d = new Date(from);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute, 0, 0));
  if (next.getTime() <= from) next.setUTCDate(next.getUTCDate() + 1);
  if (weekday !== undefined) while (next.getUTCDay() !== weekday) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - from;
}

export function startWorker(opts: WorkerOptions = {}): Worker {
  const log = opts.log ?? ((l: string) => console.log(`[worker] ${l}`));
  const now = opts.now ?? Date.now;
  const db = () => (opts.sql ? opts.sql() : (realSql() as unknown as Sql));
  const concurrency = opts.concurrency ?? 2;
  const pollMs = opts.pollMs ?? 15_000;
  const graceMs = opts.graceMs ?? Number(process.env.PAPERBOY_SHUTDOWN_GRACE_MS || 20_000);
  const runArticle =
    opts.runArticle ??
    (async (id: string) => {
      const { runArticle } = await import("@/lib/engine/pipeline");
      await runArticle(id);
    });
  const runJob =
    opts.runJob ??
    (async (job: string, payload: Record<string, unknown> = {}) => {
      const { runJob } = await import("@/lib/jobs");
      return runJob(job, payload);
    });

  const inFlight = new Map<string, Promise<void>>();
  const timers = new Set<NodeJS.Timeout>();
  let stopping = false;
  let polling = false;

  async function tick(): Promise<number> {
    if (stopping || polling) return 0;
    polling = true;
    try {
      const free = concurrency - inFlight.size;
      if (free <= 0) return 0;
      // The pipeline claims the article itself (a lock in articles.locked_until), so two workers never run one article.
      // Here we only look for planned articles nobody holds. Three failed tries and the hourly scheduler gives up on it.
      const rows = await db()`select id from articles where status = 'planned' and attempts < 4 and (locked_until is null or locked_until < now())
        order by created_at limit ${free + inFlight.size}`;
      let started = 0;
      for (const r of rows) {
        if (inFlight.size >= concurrency) break;
        if (inFlight.has(r.id)) continue;
        log(`running article ${r.id}`);
        const p = runArticle(r.id)
          .catch((e) => log(`article ${r.id} crashed: ${e instanceof Error ? e.message : String(e)}`))
          .finally(() => {
            inFlight.delete(r.id);
          });
        inFlight.set(r.id, p);
        started++;
      }
      return started;
    } catch (e) {
      log(`poll failed: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    } finally {
      polling = false;
    }
  }

  async function job(name: string, payload: Record<string, unknown> = {}) {
    if (stopping) return;
    const t = now();
    try {
      const out = await runJob(name, payload);
      const lines = Array.isArray(out) ? out : [];
      log(`job ${name} done in ${Math.round((now() - t) / 100) / 10}s${lines.length ? `: ${lines.slice(0, 5).join("; ")}${lines.length > 5 ? ` (+${lines.length - 5} more)` : ""}` : ""}`);
    } catch (e) {
      log(`job ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const every = (ms: number, fn: () => Promise<void>, firstInMs = ms) => {
    const arm = (wait: number) => {
      const t = setTimeout(() => {
        timers.delete(t);
        if (stopping) return;
        void fn().finally(() => !stopping && arm(ms));
      }, wait);
      t.unref?.();
      timers.add(t);
    };
    arm(firstInMs);
  };
  /** Fires at a fixed UTC time, recomputing the wait each time so it does not drift. */
  const at = (hour: number, minute: number, fn: () => Promise<void>, weekday?: number) => {
    const arm = () => {
      const t = setTimeout(() => {
        timers.delete(t);
        if (stopping) return;
        void fn().finally(() => !stopping && arm());
      }, msUntilUtc(now(), hour, minute, weekday));
      t.unref?.();
      timers.add(t);
    };
    arm();
  };

  const poll = setInterval(() => void tick(), pollMs);
  timers.add(poll);
  void tick();
  if (opts.jobs !== false) {
    every(HOUR, () => job("schedule"), 60_000);
    at(6, 15, () => job("gsc"));
    at(13, 0, () => job("weekly"), 1);
  }
  log(`started: polling every ${pollMs / 1000}s, ${concurrency} at a time${opts.jobs === false ? ", recurring jobs off" : ""}`);

  return {
    tick,
    running: () => [...inFlight.keys()],
    async stop() {
      if (stopping) return;
      stopping = true;
      for (const t of timers) {
        clearTimeout(t);
        clearInterval(t);
      }
      timers.clear();
      if (inFlight.size) {
        log(`stopping: waiting up to ${Math.round(graceMs / 1000)}s for ${inFlight.size} article(s)`);
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([Promise.allSettled([...inFlight.values()]), new Promise((r) => (timer = setTimeout(r, graceMs)))]);
        if (timer) clearTimeout(timer);
        if (inFlight.size) log(`stopped with ${inFlight.size} article(s) still running; their locks expire and the scheduler restarts them`);
      }
      log("stopped");
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const worker = startWorker();
  const shutdown = (sig: string) => {
    console.log(`[worker] ${sig} received`);
    void worker.stop().then(() => process.exit(0));
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}
