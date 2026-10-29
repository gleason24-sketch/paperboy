import { ApiClient, type FetchFn } from './api.js';
import type { Flags } from './args.js';
import type { Env, Settings } from './config.js';
import type { OpenFn } from './open.js';
import type { Output } from './output.js';

export interface Deps {
  fetch: FetchFn | undefined;
  sleep: (ms: number) => Promise<void>;
  open: OpenFn;
  /** Ask a yes/no question. Only called in interactive terminals. */
  confirm: (question: string) => Promise<boolean>;
  interactive: boolean;
}

export interface Context {
  flags: Flags;
  args: string[];
  env: Env;
  out: Output;
  settings: Settings;
  deps: Deps;
  /** Build an API client from the resolved settings, optionally overriding the base URL or key. */
  client(overrides?: { baseUrl?: string; apiKey?: string | undefined; timeoutMs?: number }): ApiClient;
}

export type Command = (ctx: Context) => Promise<number>;

export function makeClient(ctx: Pick<Context, 'settings' | 'deps'>, overrides: Parameters<Context['client']>[0] = {}): ApiClient {
  return new ApiClient({
    baseUrl: overrides.baseUrl ?? ctx.settings.baseUrl,
    apiKey: 'apiKey' in overrides ? overrides.apiKey : ctx.settings.apiKey,
    fetch: ctx.deps.fetch,
    timeoutMs: overrides.timeoutMs,
  });
}
