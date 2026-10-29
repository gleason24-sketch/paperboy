import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/main.js';
import type { FetchFn } from '../src/api.js';

const DASHES = new RegExp('[\\u2013\\u2014]');

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout parsed as the single JSON object printed in --json mode. */
  json(): any;
  sleeps: number[];
  opened: string[];
  configDir: string;
}

const dirs: string[] = [];

export function tmpConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'paperboy-cli-test-'));
  dirs.push(dir);
  return join(dir, 'paperboy');
}

export function cleanupTmp(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export async function cli(
  argv: string[],
  opts: { env?: Record<string, string | undefined>; configDir?: string; tty?: boolean; fetch?: FetchFn } = {},
): Promise<CliResult> {
  const configDir = opts.configDir ?? tmpConfigDir();
  let stdout = '';
  let stderr = '';
  const sleeps: number[] = [];
  const opened: string[] = [];
  const code = await run(argv, {
    env: { PAPERBOY_CONFIG_DIR: configDir, PAPERBOY_NO_OPEN: undefined, ...opts.env },
    stdout: { write: (c) => ((stdout += c), true), isTTY: opts.tty ?? false },
    stderr: { write: (c) => ((stderr += c), true) },
    sleep: async (ms) => void sleeps.push(ms),
    open: (url) => void opened.push(url),
    interactive: false,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  if (DASHES.test(stdout + stderr)) throw new Error(`output contains a dash character:\n${stdout}${stderr}`);
  return {
    code,
    stdout,
    stderr,
    json: () => JSON.parse(stdout),
    sleeps,
    opened,
    configDir,
  };
}
