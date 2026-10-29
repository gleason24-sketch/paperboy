import { parseArgs } from 'node:util';
import { CliError } from './errors.js';

export const OPTIONS = {
  json: { type: 'boolean' },
  site: { type: 'string' },
  'api-key': { type: 'string' },
  'base-url': { type: 'string' },
  'no-color': { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  'self-host': { type: 'string' },
  'no-wait': { type: 'boolean' },
  'no-open': { type: 'boolean' },
  wait: { type: 'boolean' },
  n: { type: 'string', short: 'n' },
  topic: { type: 'string' },
  publish: { type: 'boolean' },
  sources: { type: 'string' },
  days: { type: 'string' },
  markdown: { type: 'boolean' },
} as const;

type Parsed = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
export type Flags = Parsed['values'];

export interface ParsedArgs {
  flags: Flags;
  positionals: string[];
}

export function parse(argv: string[]): ParsedArgs {
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    return { flags: values, positionals };
  } catch (err) {
    throw new CliError('usage', (err instanceof Error ? err.message : String(err)) + ' (see `paperboy --help`)');
  }
}

export function intFlag(value: string | undefined, name: string, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new CliError('usage', `--${name} must be a whole number between 1 and ${max}.`);
  }
  return n;
}
