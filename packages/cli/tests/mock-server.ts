import { createServer, type IncomingMessage, type Server } from 'node:http';

export const API_KEY = 'pb_live_abcd1234_fixture_not_a_real_key';

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingMessage['headers'];
  body: any;
}

export interface MockState {
  /** Responses for POST /device/token, consumed in order. When empty the token is issued. */
  tokenQueue: { status: number; body: unknown }[];
  sites: { id: string; domain: string; gsc_connected: boolean }[];
  /** GET /sites/:id reports gsc_connected only after this many polls. */
  gscPollsUntilConnected: number;
  /** Job polls that return queued or running before done. */
  jobPolls: number;
  /** How POST /fact-check answers. */
  checkMode: 'pass' | 'fail' | 'job';
  /** Whether POST /sites returns gsc_connect_url inline. */
  inlineGscUrl: boolean;
  /** POST /gsc/connect answers 501 gsc_not_configured, like a self-host without a Google OAuth client. */
  gscNotConfigured: boolean;
  publishResult: { published: boolean; url?: string };
}

export interface Mock {
  url: string;
  calls: Call[];
  state: MockState;
  callsTo(method: string, path: string): Call[];
  close(): Promise<void>;
}

const PASS_RESULT = {
  pass: true,
  claims_total: 2,
  claims_verified: 2,
  checks: [
    { claim: 'Water boils at 100C at sea level', status: 'verified', source: 'https://example.org/boiling' },
    { claim: 'The Eiffel Tower is in Paris', status: 'verified', source: 'https://example.org/eiffel' },
  ],
};

const FAIL_RESULT = {
  pass: false,
  claims_total: 3,
  claims_verified: 1,
  checks: [
    { claim: 'Water boils at 100C at sea level', status: 'verified', source: 'https://example.org/boiling' },
    { claim: 'Our tool is 10x faster', status: 'held', note: 'no source found' },
    { claim: 'The moon is 5 km away', status: 'mismatch', source: 'https://example.org/moon' },
  ],
};

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
}

export async function startMock(): Promise<Mock> {
  const calls: Call[] = [];
  const polls: Record<string, number> = {};
  const state: MockState = {
    tokenQueue: [],
    sites: [{ id: 'site_1', domain: 'example.com', gsc_connected: true }],
    gscPollsUntilConnected: 0,
    jobPolls: 2,
    checkMode: 'pass',
    inlineGscUrl: true,
    gscNotConfigured: false,
    publishResult: { published: true, url: 'https://example.com/blog/post' },
  };

  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost');
    const body = await readBody(req);
    const call: Call = {
      method: req.method ?? 'GET',
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      headers: req.headers,
      body,
    };
    calls.push(call);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const p = u.pathname;
    const m = call.method;

    // Unauthenticated device flow.
    if (m === 'POST' && p === '/api/v1/device/code') {
      return json(res, 200, {
        device_code: 'dev_123',
        user_code: 'ABCD-EFGH',
        verification_uri: `${base}/device`,
        verification_uri_complete: `${base}/device?code=ABCD-EFGH`,
        interval: 1,
        expires_in: 600,
      });
    }
    if (m === 'POST' && p === '/api/v1/device/token') {
      const next = state.tokenQueue.shift();
      if (next) return json(res, next.status, next.body);
      return json(res, 200, { api_key: API_KEY, token_type: 'bearer' });
    }

    if (req.headers.authorization !== `Bearer ${API_KEY}`) {
      return json(res, 401, { error: { code: 'unauthorized', message: 'Invalid API key', request_id: 'req_401' } });
    }

    if (m === 'GET' && p === '/api/v1/me') {
      return json(res, 200, { owner: { email: 'owner@example.com' }, credits: { enabled: true, balance: 1234 } });
    }
    if (m === 'GET' && p === '/api/v1/sites') return json(res, 200, { sites: state.sites });
    if (m === 'POST' && p === '/api/v1/sites') {
      const domain = new URL(body.url).hostname.replace(/^www\./, '');
      const site = { id: 'site_new', domain, gsc_connected: false };
      state.sites = [site];
      return json(res, 201, { site, ...(state.inlineGscUrl ? { gsc_connect_url: `${base}/gsc/start?site=site_new` } : {}) });
    }
    let match = p.match(/^\/api\/v1\/sites\/([^/]+)\/gsc\/connect$/);
    if (m === 'POST' && match) {
      if (state.gscNotConfigured) return json(res, 501, { error: { code: 'gsc_not_configured', message: 'Search Console is not set up on this server.', request_id: 'req_501' } });
      return json(res, 200, { url: `${base}/gsc/start?site=${match[1]}` });
    }

    match = p.match(/^\/api\/v1\/sites\/([^/]+)$/);
    if (m === 'GET' && match) {
      const id = match[1]!;
      polls[`site:${id}`] = (polls[`site:${id}`] ?? 0) + 1;
      const known = state.sites.find((s) => s.id === id);
      if (!known) return json(res, 404, { error: { code: 'not_found', message: 'No such site', request_id: 'req_404' } });
      const connected = known.gsc_connected || polls[`site:${id}`]! > state.gscPollsUntilConnected;
      return json(res, 200, {
        site: {
          ...known,
          gsc_connected: connected,
          publish_method: 'webhook',
          articles: [{ id: 'art_1', title: 'How to brew coffee', status: 'published', url: 'https://example.com/blog/coffee' }],
        },
      });
    }

    match = p.match(/^\/api\/v1\/sites\/([^/]+)\/topics$/);
    if (m === 'POST' && match) {
      return json(res, 200, {
        topics: [
          { id: 'top_1', title: 'Best coffee grinders', query: 'best coffee grinder', reason: 'Page two with rising impressions', signals: { impressions: 12400, position: 11.3, serp_gate: 'pass' } },
          { id: 'top_2', title: 'Cold brew ratios', query: 'cold brew ratio', reason: 'No existing page covers it', signals: { impressions: 800, position: 24.1, serp_gate: 'pass' } },
        ].slice(0, body?.n ?? 5),
      });
    }
    match = p.match(/^\/api\/v1\/sites\/([^/]+)\/articles$/);
    if (m === 'POST' && match) return json(res, 202, { job_id: 'job_write', article_id: 'art_9' });

    match = p.match(/^\/api\/v1\/jobs\/([^/]+)$/);
    if (m === 'GET' && match) {
      const id = match[1]!;
      polls[id] = (polls[id] ?? 0) + 1;
      const n = polls[id]!;
      if (n <= state.jobPolls) {
        return json(res, 200, { status: n === 1 ? 'queued' : 'running', step: n === 1 ? undefined : 'fact-checking claims' });
      }
      if (id === 'job_check') return json(res, 200, { status: 'done', result: PASS_RESULT });
      return json(res, 200, { status: 'done', article_id: 'art_9' });
    }
    match = p.match(/^\/api\/v1\/articles\/([^/]+)$/);
    if (m === 'GET' && match) {
      return json(res, 200, {
        id: match[1],
        title: 'The Best Coffee Grinders',
        status: 'draft',
        url: null,
        verdict: { pass: true, score: 94, checks: [
          { claim: 'Burr grinders give a more even grind', status: 'verified', source: 'https://example.org/burr' },
          { claim: 'Grinders last ten years', status: 'held' },
        ] },
      });
    }
    match = p.match(/^\/api\/v1\/articles\/([^/]+)\/publish$/);
    if (m === 'POST' && match) return json(res, 200, state.publishResult);

    if (m === 'POST' && p === '/api/v1/fact-check') {
      if (state.checkMode === 'job') return json(res, 202, { job_id: 'job_check' });
      return json(res, 200, state.checkMode === 'pass' ? PASS_RESULT : FAIL_RESULT);
    }
    match = p.match(/^\/api\/v1\/sites\/([^/]+)\/performance$/);
    if (m === 'GET' && match) {
      const days = Number(u.searchParams.get('days') ?? 28);
      return json(res, 200, {
        days,
        totals: { clicks: 1500, impressions: 60000, position: 12.34 },
        daily: Array.from({ length: 10 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, clicks: i * 10, impressions: 1000 + i * 100 })),
      });
    }
    match = p.match(/^\/api\/v1\/sites\/([^/]+)\/reports$/);
    if (m === 'POST' && match) return json(res, 200, { markdown: `# Report\n\nLast ${body.days} days: 1500 clicks.\n`, data: { days: body.days } });

    return json(res, 404, { error: { code: 'not_found', message: `No route ${m} ${p}`, request_id: 'req_nf' } });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    state,
    callsTo: (method, path) => calls.filter((c) => c.method === method && c.path === path),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
