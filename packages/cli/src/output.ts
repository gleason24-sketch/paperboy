import { CliError } from './errors.js';
import type { Env } from './config.js';

export interface Sink {
  write(chunk: string): unknown;
  isTTY?: boolean | undefined;
}

export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

function wrap(on: boolean, open: number, close: number): (s: string) => string {
  return (s) => (on ? `\u001b[${open}m${s}\u001b[${close}m` : s);
}

export function makeStyle(on: boolean): Style {
  return {
    bold: wrap(on, 1, 22),
    dim: wrap(on, 2, 22),
    red: wrap(on, 31, 39),
    green: wrap(on, 32, 39),
    yellow: wrap(on, 33, 39),
    cyan: wrap(on, 36, 39),
  };
}

export function colorEnabled(opts: { env: Env; stdout: Sink; noColorFlag: boolean }): boolean {
  if (opts.noColorFlag) return false;
  if (opts.env['NO_COLOR'] !== undefined && opts.env['NO_COLOR'] !== '') return false;
  if (opts.env['FORCE_COLOR'] && opts.env['FORCE_COLOR'] !== '0') return true;
  return Boolean(opts.stdout.isTTY) && opts.env['TERM'] !== 'dumb';
}

export class Output {
  readonly json: boolean;
  readonly style: Style;
  private readonly stdout: Sink;
  private readonly stderr: Sink;

  constructor(opts: { stdout: Sink; stderr: Sink; json: boolean; color: boolean }) {
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
    this.json = opts.json;
    this.style = makeStyle(opts.color);
  }

  /** Human mode only: print a line to stdout. */
  line(text = ''): void {
    if (!this.json) this.stdout.write(text + '\n');
  }

  /** Alias of line, used for progress notes. */
  info(text: string): void {
    this.line(text);
  }

  /** Things the user must see even in JSON mode (device codes, links): stdout when human, stderr when JSON. */
  prompt(text: string): void {
    if (this.json) this.stderr.write(text + '\n');
    else this.stdout.write(text + '\n');
  }

  /** Emit the result of a command: one JSON object in JSON mode, otherwise run the human renderer. */
  result(command: string, data: unknown, human: () => void): void {
    if (this.json) this.stdout.write(JSON.stringify({ ok: true, command, data }) + '\n');
    else human();
  }

  fail(err: unknown): void {
    const e = toCliError(err);
    if (this.json) {
      const error: { code: string; message: string; status?: number } = { code: e.code, message: e.message };
      if (e.status !== undefined) error.status = e.status;
      this.stdout.write(JSON.stringify({ ok: false, error }) + '\n');
    } else {
      this.stderr.write(`${this.style.red('error:')} ${e.message}\n`);
    }
  }
}

export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new CliError('unexpected_error', message);
}

export function num(n: unknown): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '0';
}

export function fixed(n: unknown, digits = 1): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : '-';
}

const BARS = '▁▂▃▄▅▆▇█';

export function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min;
  return values
    .map((v) => BARS[span === 0 ? (max === 0 ? 0 : 3) : Math.round(((v - min) / span) * (BARS.length - 1))])
    .join('');
}

export function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

export function padLeft(s: string, width: number): string {
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}
