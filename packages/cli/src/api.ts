import { ApiError, CliError } from './errors.js';
import { VERSION } from './version.js';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: FetchFn | undefined;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number | undefined;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Sent as the Idempotency-Key header. */
  idempotencyKey?: string;
  /** Set false for unauthenticated endpoints such as the device flow. */
  auth?: boolean;
  timeoutMs?: number;
}

export interface ApiResult<T> {
  status: number;
  data: T;
}

export class ApiClient {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  get<T>(path: string, opts: RequestOptions = {}): Promise<ApiResult<T>> {
    return this.request<T>('GET', path, opts);
  }

  post<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<ApiResult<T>> {
    return this.request<T>('POST', path, { ...opts, body: body ?? {} });
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResult<T>> {
    const auth = opts.auth ?? true;
    if (auth && !this.apiKey) {
      throw new ApiError({ code: 'unauthenticated', status: 401 });
    }

    let url = this.baseUrl + path;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) params.set(key, String(value));
    }
    const qs = params.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': `paperboy-cli/${VERSION}`,
    };
    if (auth && this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs) };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await this.fetchFn(url, init);
    } catch (err) {
      throw networkError(err, this.baseUrl);
    }

    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw networkError(err, this.baseUrl);
    }
    const parsed = parseJson(text);

    if (!res.ok) throw toApiError(res.status, parsed, text);
    if (parsed === undefined && text.trim() !== '') {
      throw new CliError(
        'bad_response',
        `${this.baseUrl} did not return JSON. Check the URL (use --base-url or --self-host).`,
        res.status,
      );
    }
    return { status: res.status, data: (parsed ?? {}) as T };
  }
}

function parseJson(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function networkError(err: unknown, baseUrl: string): CliError {
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new CliError('timeout', `The request to ${baseUrl} timed out.`);
  }
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
  const message = cause ?? (err instanceof Error ? err.message : String(err));
  return new CliError('network_error', `Could not reach ${baseUrl}: ${message}`);
}

/** Accepts both {error:{code,message,request_id}} and the RFC 6749 style {error:"code"}. */
export function toApiError(status: number, body: unknown, rawText = ''): ApiError {
  let code = `http_${status}`;
  let apiMessage: string | undefined;
  let requestId: string | undefined;
  if (body && typeof body === 'object') {
    const err = (body as Record<string, unknown>)['error'];
    if (typeof err === 'string') {
      code = err;
      const desc = (body as Record<string, unknown>)['error_description'];
      if (typeof desc === 'string') apiMessage = desc;
    } else if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>;
      if (typeof e['code'] === 'string') code = e['code'];
      if (typeof e['message'] === 'string') apiMessage = e['message'];
      if (typeof e['request_id'] === 'string') requestId = e['request_id'];
    }
  } else if (rawText && rawText.length < 200 && !rawText.trimStart().startsWith('<')) {
    apiMessage = rawText.trim();
  }
  const opts: { code: string; status: number; apiMessage?: string; requestId?: string } = { code, status };
  if (apiMessage !== undefined) opts.apiMessage = apiMessage;
  if (requestId !== undefined) opts.requestId = requestId;
  return new ApiError(opts);
}
