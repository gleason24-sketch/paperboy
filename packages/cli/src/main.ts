import { createInterface } from 'node:readline/promises';
import { parse } from './args.js';
import { type Command, type Context, makeClient } from './context.js';
import { CliError } from './errors.js';
import { type Env, readConfig, resolveSettings } from './config.js';
import { type OpenFn, openBrowser } from './open.js';
import { Output, type Sink, colorEnabled } from './output.js';
import { VERSION } from './version.js';
import type { FetchFn } from './api.js';
import { check } from './commands/check.js';
import { connect } from './commands/connect.js';
import { mcp } from './commands/mcp.js';
import { publish } from './commands/publish.js';
import { report } from './commands/report.js';
import { status } from './commands/status.js';
import { topics } from './commands/topics.js';
import { write } from './commands/write.js';
import { HELP } from './help.js';

export interface RunOptions {
  env?: Env;
  stdout?: Sink;
  stderr?: Sink;
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  open?: OpenFn;
  confirm?: (question: string) => Promise<boolean>;
  /** Force interactive behaviour on or off. Defaults to whether stdout is a TTY. */
  interactive?: boolean;
}

const COMMANDS: Record<string, Command> = { connect, topics, write, check, publish, status, report, mcp };

async function defaultConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** Run the CLI and return the process exit code: 0 ok, 1 check failed, 2 error. */
export async function run(argv: string[], opts: RunOptions = {}): Promise<number> {
  const env = opts.env ?? process.env;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const out = new Output({
    stdout,
    stderr,
    json: argv.includes('--json'),
    color: colorEnabled({ env, stdout, noColorFlag: argv.includes('--no-color') }),
  });

  try {
    const { flags, positionals } = parse(argv);
    const [command, ...args] = positionals;

    if (flags.version) {
      out.result('version', { version: VERSION }, () => out.line(`paperboy ${VERSION}`));
      return 0;
    }
    if (flags.help || !command || command === 'help') {
      out.result('help', { usage: HELP }, () => out.line(HELP));
      return 0;
    }
    const handler = COMMANDS[command];
    if (!handler) throw new CliError('usage', `Unknown command "${command}". Run \`paperboy --help\` for the list.`);

    const settings = resolveSettings(flags, env, readConfig(env));
    const interactive = opts.interactive ?? Boolean(stdout.isTTY && process.stdin.isTTY);
    const ctx: Context = {
      flags,
      args,
      env,
      out,
      settings,
      deps: {
        fetch: opts.fetch,
        sleep: opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
        open: opts.open ?? openBrowser,
        confirm: opts.confirm ?? defaultConfirm,
        interactive,
      },
      client: (overrides) => makeClient(ctx, overrides),
    };
    return await handler(ctx);
  } catch (err) {
    out.fail(err);
    return 2;
  }
}
