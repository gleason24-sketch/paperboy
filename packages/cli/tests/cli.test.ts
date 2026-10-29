import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configDir, maskKey, resolveSettings } from '../src/config.js';
import { VERSION } from '../src/version.js';
import { cleanupTmp, cli, tmpConfigDir } from './helpers.js';
import { API_KEY, startMock, type Mock } from './mock-server.js';

let mock: Mock;
beforeEach(async () => {
  mock = await startMock();
});
afterEach(async () => {
  await mock.close();
  cleanupTmp();
});

function authed(extra: Record<string, string> = {}) {
  return { env: { PAPERBOY_BASE_URL: mock.url, PAPERBOY_API_KEY: API_KEY, ...extra } };
}

function readSaved(dir: string) {
  return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
}

describe('connect: device flow', () => {
  it('signs in, prints the code, opens the browser and saves the key with safe permissions', async () => {
    const r = await cli(['connect', '--base-url', mock.url]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ABCD-EFGH');
    expect(r.stdout).toContain(`${mock.url}/device?code=ABCD-EFGH`);
    expect(r.opened).toEqual([`${mock.url}/device?code=ABCD-EFGH`]);
    expect(mock.callsTo('POST', '/api/v1/device/code')[0]?.body).toEqual({ client: 'paperboy-cli' });
    expect(mock.callsTo('POST', '/api/v1/device/token')[0]?.body).toEqual({ device_code: 'dev_123' });

    expect(readSaved(r.configDir)).toEqual({ base_url: mock.url, api_key: API_KEY });
    expect(statSync(join(r.configDir, 'config.json')).mode & 0o777).toBe(0o600);
    expect(statSync(r.configDir).mode & 0o777).toBe(0o700);

    // The key is only ever shown masked.
    expect(r.stdout).toContain('pb_live_abcd...');
    expect(r.stdout + r.stderr).not.toContain(API_KEY);
  });

  it('keeps polling through authorization_pending', async () => {
    mock.state.tokenQueue = [
      { status: 400, body: { error: { code: 'authorization_pending', message: 'pending' } } },
      { status: 428, body: { error: { code: 'authorization_pending', message: 'pending' } } },
    ];
    const r = await cli(['connect', '--base-url', mock.url]);
    expect(r.code).toBe(0);
    expect(mock.callsTo('POST', '/api/v1/device/token')).toHaveLength(3);
    expect(r.sleeps).toEqual([1000, 1000, 1000]);
    expect(readSaved(r.configDir).api_key).toBe(API_KEY);
  });

  it('adds 5 seconds to the interval on slow_down', async () => {
    mock.state.tokenQueue = [{ status: 400, body: { error: { code: 'slow_down', message: 'slow' } } }];
    const r = await cli(['connect', '--base-url', mock.url]);
    expect(r.code).toBe(0);
    expect(r.sleeps).toEqual([1000, 6000]);
  });

  it('fails on expired_token without writing a config', async () => {
    mock.state.tokenQueue = [{ status: 400, body: { error: { code: 'expired_token', message: 'gone' } } }];
    const r = await cli(['connect', '--base-url', mock.url, '--json']);
    expect(r.code).toBe(2);
    expect(r.json()).toMatchObject({ ok: false, error: { code: 'expired_token' } });
    expect(existsSync(join(r.configDir, 'config.json'))).toBe(false);
  });

  it('fails on access_denied', async () => {
    mock.state.tokenQueue = [{ status: 400, body: { error: { code: 'access_denied', message: 'no' } } }];
    const r = await cli(['connect', '--base-url', mock.url]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('denied');
  });

  it('does not open the browser with --no-open or --json', async () => {
    const a = await cli(['connect', '--base-url', mock.url, '--no-open']);
    expect(a.opened).toEqual([]);
    const b = await cli(['connect', '--base-url', mock.url, '--json']);
    expect(b.opened).toEqual([]);
    // In JSON mode stdout is exactly one object; the code goes to stderr.
    expect(b.json()).toMatchObject({ ok: true, command: 'connect', data: { api_key_preview: 'pb_live_abcd...' } });
    expect(b.stderr).toContain('ABCD-EFGH');
    expect(b.stdout).not.toContain(API_KEY);
  });

  it('--self-host sets the saved base_url', async () => {
    const r = await cli(['connect', '--self-host', mock.url]);
    expect(r.code).toBe(0);
    expect(readSaved(r.configDir).base_url).toBe(mock.url);
  });

  it('--api-key skips the device flow and verifies the key', async () => {
    const r = await cli(['connect', '--api-key', API_KEY, '--self-host', mock.url]);
    expect(r.code).toBe(0);
    expect(mock.callsTo('POST', '/api/v1/device/code')).toHaveLength(0);
    expect(readSaved(r.configDir).api_key).toBe(API_KEY);

    const bad = await cli(['connect', '--api-key', 'nope', '--self-host', mock.url, '--json']);
    expect(bad.code).toBe(2);
    expect(bad.json().error.code).toBe('invalid_api_key');
  });
});

describe('connect: site and Search Console', () => {
  it('creates the site, opens the GSC link and waits until connected', async () => {
    mock.state.gscPollsUntilConnected = 2;
    const r = await cli(['connect', 'https://www.shop.example', '--self-host', mock.url]);
    expect(r.code).toBe(0);
    expect(mock.callsTo('POST', '/api/v1/sites')[0]?.body).toEqual({ url: 'https://www.shop.example' });
    expect(r.opened).toContain(`${mock.url}/gsc/start?site=site_new`);
    expect(mock.callsTo('GET', '/api/v1/sites/site_new')).toHaveLength(3);
    expect(r.sleeps.filter((ms) => ms === 3000)).toHaveLength(3);
    expect(r.stdout).toContain('Search Console: connected');
    expect(readSaved(r.configDir).default_site).toBe('site_new');
  });

  it('falls back to POST /gsc/connect when no link is returned inline', async () => {
    mock.state.inlineGscUrl = false;
    const r = await cli(['connect', 'shop.example', '--self-host', mock.url]);
    expect(r.code).toBe(0);
    expect(mock.callsTo('POST', '/api/v1/sites')[0]?.body).toEqual({ url: 'https://shop.example' });
    expect(mock.callsTo('POST', '/api/v1/sites/site_new/gsc/connect')).toHaveLength(1);
    expect(r.opened).toContain(`${mock.url}/gsc/start?site=site_new`);
  });

  it('--no-wait prints the link and does not poll', async () => {
    const r = await cli(['connect', 'https://shop.example', '--self-host', mock.url, '--no-wait', '--json']);
    expect(r.code).toBe(0);
    expect(mock.callsTo('GET', '/api/v1/sites/site_new')).toHaveLength(0);
    const out = r.json();
    expect(out.data.site.gsc_connected).toBe(false);
    expect(out.data.gsc_connect_url).toBe(`${mock.url}/gsc/start?site=site_new`);
    expect(readSaved(r.configDir).default_site).toBe('site_new');
  });
});

describe('topics', () => {
  it('prints a numbered list with why and signals', async () => {
    const r = await cli(['topics', '--n', '2'], authed());
    expect(r.code).toBe(0);
    expect(mock.callsTo('POST', '/api/v1/sites/site_1/topics')[0]?.body).toEqual({ n: 2 });
    expect(r.stdout).toMatch(/1\. Best coffee grinders/);
    expect(r.stdout).toMatch(/2\. Cold brew ratios/);
    expect(r.stdout).toContain('why: Page two with rising impressions');
    expect(r.stdout).toContain('12,400 impressions');
    expect(r.stdout).toContain('position 11.3');
    expect(r.stdout).toContain('serp gate: pass');
  });

  it('--json prints exactly one object', async () => {
    const r = await cli(['topics', '--json'], authed());
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    const out = r.json();
    expect(out.ok).toBe(true);
    expect(out.command).toBe('topics');
    expect(out.data.topics).toHaveLength(2);
    expect(mock.callsTo('POST', '/api/v1/sites/site_1/topics')[0]?.body).toEqual({ n: 5 });
  });

  it('rejects a bad --n', async () => {
    const r = await cli(['topics', '--n', 'abc', '--json'], authed());
    expect(r.code).toBe(2);
    expect(r.json().error.code).toBe('usage');
  });
});

describe('write', () => {
  it('--wait polls the job and prints the article and fact-check summary', async () => {
    const r = await cli(['write', '--topic', 'top_1', '--wait'], authed());
    expect(r.code).toBe(0);
    const post = mock.callsTo('POST', '/api/v1/sites/site_1/articles')[0]!;
    expect(post.body).toEqual({ topic_id: 'top_1', publish: false });
    expect(post.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(mock.callsTo('GET', '/api/v1/jobs/job_write')).toHaveLength(3);
    expect(r.sleeps).toEqual([2000, 2000]);
    expect(r.stdout).toContain('fact-checking claims');
    expect(r.stdout).toContain('The Best Coffee Grinders');
    expect(r.stdout).toContain('status: draft');
    expect(r.stdout).toContain('1 claims verified, 1 held');
  });

  it('sends free text as topic and --publish as publish', async () => {
    const r = await cli(['write', '--topic', 'how to descale a kettle', '--publish', '--wait', '--yes'], authed());
    expect(r.code).toBe(0);
    expect(mock.callsTo('POST', '/api/v1/sites/site_1/articles')[0]?.body).toEqual({
      topic: 'how to descale a kettle',
      publish: true,
    });
  });

  it('without --wait on a non-TTY returns the job and exits', async () => {
    const r = await cli(['write', '--json'], authed());
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ ok: true, command: 'write', data: { job_id: 'job_write', article_id: 'art_9' } });
    expect(mock.callsTo('GET', '/api/v1/jobs/job_write')).toHaveLength(0);
  });

  it('--wait --json includes the article', async () => {
    const r = await cli(['write', '--wait', '--json'], authed());
    const out = r.json();
    expect(out.data.article).toMatchObject({ id: 'art_9', title: 'The Best Coffee Grinders' });
  });

  it('reports a failed job', async () => {
    const failing = await cli(['write', '--wait', '--json'], {
      ...authed(),
      fetch: async (url, init) => {
        if (url.includes('/jobs/')) {
          return new Response(JSON.stringify({ status: 'failed', error: { message: 'Fact-check blocked the draft' } }), {
            status: 200,
          });
        }
        return fetch(url, init);
      },
    });
    expect(failing.code).toBe(2);
    expect(failing.json().error).toMatchObject({ code: 'job_failed', message: 'Fact-check blocked the draft' });
  });
});

describe('check', () => {
  it('exits 0 and shows VERIFIED when the check passes', async () => {
    const r = await cli(['check', 'https://example.com/post'], authed());
    expect(r.code).toBe(0);
    expect(mock.callsTo('POST', '/api/v1/fact-check')[0]?.body).toEqual({ url: 'https://example.com/post' });
    expect(mock.callsTo('POST', '/api/v1/fact-check')[0]?.headers['idempotency-key']).toBeTruthy();
    expect(r.stdout).toContain('PASS');
    expect(r.stdout).toContain('VERIFIED');
    expect(r.stdout).toContain('2 of 2 claims verified');
  });

  it('exits 1 and shows HELD when the check fails', async () => {
    mock.state.checkMode = 'fail';
    const r = await cli(['check', 'https://example.com/post'], authed());
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('FAIL');
    expect(r.stdout).toContain('HELD');
    expect(r.stdout).toContain('MISMATCH');
    expect(r.stdout).toContain('1 of 3 claims verified');
  });

  it('--json keeps exit code 1 on failure and prints one object', async () => {
    mock.state.checkMode = 'fail';
    const r = await cli(['check', 'https://example.com/post', '--json'], authed());
    expect(r.code).toBe(1);
    expect(r.json()).toMatchObject({ ok: true, command: 'check', data: { pass: false, claims_total: 3 } });
  });

  it('follows a 202 job to its result', async () => {
    mock.state.checkMode = 'job';
    const r = await cli(['check', 'https://example.com/post', '--json'], authed());
    expect(r.code).toBe(0);
    expect(mock.callsTo('GET', '/api/v1/jobs/job_check').length).toBeGreaterThan(1);
    expect(r.json().data.pass).toBe(true);
  });

  it('reads markdown from a file and sources from a file', async () => {
    const dir = tmpConfigDir();
    mkdirSync(dir, { recursive: true });
    const md = join(dir, 'post.md');
    const src = join(dir, 'sources.txt');
    writeFileSync(md, '# Title\n\nWater boils at 100C.\n');
    writeFileSync(src, '# my sources\nhttps://example.org/boiling\n\nhttps://example.org/other\n');
    const r = await cli(['check', md, '--sources', src], authed());
    expect(r.code).toBe(0);
    expect(mock.callsTo('POST', '/api/v1/fact-check')[0]?.body).toEqual({
      markdown: '# Title\n\nWater boils at 100C.\n',
      sources: ['https://example.org/boiling', 'https://example.org/other'],
    });
  });

  it('errors on a missing file or missing argument', async () => {
    const missing = await cli(['check', '/no/such/file.md', '--json'], authed());
    expect(missing.code).toBe(2);
    expect(missing.json().error.code).toBe('file_error');
    const none = await cli(['check'], authed());
    expect(none.code).toBe(2);
  });
});

describe('publish, status, report', () => {
  it('publishes an article', async () => {
    const r = await cli(['publish', 'art_9', '--yes'], authed());
    expect(r.code).toBe(0);
    expect(mock.callsTo('POST', '/api/v1/articles/art_9/publish')).toHaveLength(1);
    expect(r.stdout).toContain('Published: https://example.com/blog/post');
    const j = await cli(['publish', 'art_9', '--json'], authed());
    expect(j.json()).toEqual({ ok: true, command: 'publish', data: { published: true, url: 'https://example.com/blog/post' } });
  });

  it('exits 1 when the server did not publish', async () => {
    mock.state.publishResult = { published: false };
    const r = await cli(['publish', 'art_9'], authed());
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('Not published');
  });

  it('shows owner, credits, site, publish method, GSC and articles', async () => {
    const r = await cli(['status'], authed());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('owner@example.com');
    expect(r.stdout).toContain('1,234');
    expect(r.stdout).toContain('example.com (site_1)');
    expect(r.stdout).toContain('webhook');
    expect(r.stdout).toContain('connected');
    expect(r.stdout).toContain('How to brew coffee');
    expect(r.stdout).not.toContain(API_KEY);
    const j = await cli(['status', '--json'], authed());
    expect(j.json().data.me.credits.balance).toBe(1234);
    expect(j.json().data.site.domain).toBe('example.com');
  });

  it('prints a performance report with a sparkline', async () => {
    const r = await cli(['report', '--days', '10'], authed());
    expect(r.code).toBe(0);
    expect(mock.callsTo('GET', '/api/v1/sites/site_1/performance')[0]?.query).toEqual({ days: '10' });
    expect(r.stdout).toContain('1,500');
    expect(r.stdout).toContain('60,000');
    expect(r.stdout).toContain('12.3');
    expect(r.stdout).toContain('2.50%');
    expect(r.stdout).toMatch(/clicks per day {2}▁[▁-█]+█/);
    expect(r.stdout).toContain('2026-10-10');
  });

  it('--markdown uses the reports endpoint', async () => {
    const r = await cli(['report', '--markdown', '--days', '7'], authed());
    expect(r.code).toBe(0);
    expect(mock.callsTo('POST', '/api/v1/sites/site_1/reports')[0]?.body).toEqual({ days: 7 });
    expect(r.stdout).toContain('# Report');
    const j = await cli(['report', '--markdown', '--json'], authed());
    expect(j.json().data.markdown).toContain('# Report');
  });
});

describe('site resolution', () => {
  it('uses the only site, the saved default, a --site id or a --site domain', async () => {
    mock.state.sites = [
      { id: 'site_1', domain: 'example.com', gsc_connected: true },
      { id: 'site_2', domain: 'other.org', gsc_connected: true },
    ];
    const many = await cli(['topics', '--json'], authed());
    expect(many.code).toBe(2);
    expect(many.json().error.code).toBe('site_required');
    expect(many.json().error.message).toContain('other.org (site_2)');

    const byDomain = await cli(['topics', '--site', 'https://www.other.org/', '--json'], authed());
    expect(byDomain.code).toBe(0);
    expect(mock.callsTo('POST', '/api/v1/sites/site_2/topics')).toHaveLength(1);

    const byId = await cli(['topics', '--site', 'site_1', '--json'], authed());
    expect(byId.code).toBe(0);
    expect(mock.callsTo('POST', '/api/v1/sites/site_1/topics')).toHaveLength(1);

    const dir = tmpConfigDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ default_site: 'site_2' }));
    const saved = await cli(['topics', '--json'], { ...authed(), configDir: dir });
    expect(saved.code).toBe(0);
    expect(mock.callsTo('POST', '/api/v1/sites/site_2/topics')).toHaveLength(2);

    const unknown = await cli(['topics', '--site', 'nope.net', '--json'], authed());
    expect(unknown.json().error.code).toBe('site_not_found');
  });

  it('explains when the account has no sites', async () => {
    mock.state.sites = [];
    const r = await cli(['topics', '--json'], authed());
    expect(r.json().error.code).toBe('no_site');
  });
});

describe('config precedence and secrets', () => {
  it('resolves flag, then env, then file', () => {
    const file = { base_url: 'http://file', api_key: 'file_key', default_site: 'file_site' };
    expect(resolveSettings({}, {}, file)).toMatchObject({ baseUrl: 'http://file', apiKey: 'file_key', site: 'file_site' });
    const env = { PAPERBOY_BASE_URL: 'http://env/', PAPERBOY_API_KEY: 'env_key' };
    expect(resolveSettings({}, env, file)).toMatchObject({ baseUrl: 'http://env', apiKey: 'env_key' });
    const flags = { 'base-url': 'http://flag', 'api-key': 'flag_key', site: 'flag_site' };
    expect(resolveSettings(flags, env, file)).toMatchObject({ baseUrl: 'http://flag', apiKey: 'flag_key', site: 'flag_site' });
    expect(resolveSettings({}, {}, {}).baseUrl).toBe('https://paperboyseo.com');
  });

  it('honors PAPERBOY_CONFIG_DIR, then XDG_CONFIG_HOME, then HOME', () => {
    expect(configDir({ PAPERBOY_CONFIG_DIR: '/a', XDG_CONFIG_HOME: '/b' })).toBe('/a');
    expect(configDir({ XDG_CONFIG_HOME: '/b', HOME: '/h' })).toBe('/b/paperboy');
    expect(configDir({ HOME: '/h' })).toBe('/h/.config/paperboy');
  });

  it('applies the precedence end to end', async () => {
    const dir = tmpConfigDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ base_url: 'http://127.0.0.1:1', api_key: 'wrong_file_key' }));

    // File only: wrong key and unreachable host.
    const fileOnly = await cli(['status', '--json'], { configDir: dir });
    expect(fileOnly.code).toBe(2);
    expect(fileOnly.json().error.code).toBe('network_error');

    // Env beats file.
    const env = await cli(['status', '--json'], { configDir: dir, env: { PAPERBOY_BASE_URL: mock.url, PAPERBOY_API_KEY: API_KEY } });
    expect(env.code).toBe(0);

    // Flag beats env.
    const flag = await cli(['status', '--json', '--api-key', API_KEY, '--base-url', mock.url], {
      configDir: dir,
      env: { PAPERBOY_BASE_URL: 'http://127.0.0.1:1', PAPERBOY_API_KEY: 'wrong_env_key' },
    });
    expect(flag.code).toBe(0);
    expect(mock.calls.at(-1)?.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('masks keys to 12 characters plus an ellipsis', () => {
    expect(maskKey(API_KEY)).toBe('pb_live_abcd...');
  });
});

describe('errors', () => {
  it('maps 401 to a hint to run paperboy connect', async () => {
    const wrong = await cli(['status', '--json'], { env: { PAPERBOY_BASE_URL: mock.url, PAPERBOY_API_KEY: 'bad' } });
    expect(wrong.code).toBe(2);
    expect(wrong.json()).toMatchObject({ ok: false, error: { code: 'unauthorized', status: 401 } });
    expect(wrong.json().error.message).toContain('paperboy connect');

    // No key at all: fail locally without making a request.
    const before = mock.calls.length;
    const none = await cli(['topics'], { env: { PAPERBOY_BASE_URL: mock.url } });
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('paperboy connect');
    expect(mock.calls).toHaveLength(before);
  });

  it('maps 402 to a credits message', async () => {
    const r = await cli(['write', '--json'], {
      ...authed(),
      fetch: async (url) =>
        url.endsWith('/api/v1/sites')
          ? new Response(JSON.stringify({ sites: [{ id: 'site_1', domain: 'example.com' }] }), { status: 200 })
          : new Response(JSON.stringify({ error: { code: 'insufficient_credits', message: 'need 5', request_id: 'req_9' } }), {
              status: 402,
            }),
    });
    expect(r.code).toBe(2);
    expect(r.json().error).toMatchObject({ code: 'insufficient_credits', status: 402 });
    expect(r.json().error.message).toMatch(/not enough credits/i);
  });

  it('reports an unreachable server and a non-JSON server', async () => {
    const down = await cli(['status', '--json'], { env: { PAPERBOY_BASE_URL: 'http://127.0.0.1:1', PAPERBOY_API_KEY: API_KEY } });
    expect(down.json().error.code).toBe('network_error');
    const html = await cli(['status', '--json'], {
      ...authed(),
      fetch: async () => new Response('<html>hi</html>', { status: 200 }),
    });
    expect(html.json().error.code).toBe('bad_response');
  });

  it('prints errors on stderr in human mode', async () => {
    const r = await cli(['frobnicate']);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Unknown command');
    const bad = await cli(['topics', '--bogus', '--json']);
    expect(bad.json().error.code).toBe('usage');
  });
});

describe('help, version and color', () => {
  it('prints help and version', async () => {
    const help = await cli(['--help']);
    expect(help.code).toBe(0);
    for (const word of ['connect', 'topics', 'write', 'check', 'publish', 'status', 'report', '--json']) {
      expect(help.stdout).toContain(word);
    }
    expect((await cli([])).stdout).toContain('Usage: paperboy');
    expect((await cli(['--version'])).stdout.trim()).toBe(`paperboy ${VERSION}`);
    expect((await cli(['--version', '--json'])).json().data.version).toBe(VERSION);
  });

  it('keeps the version in sync with package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.version).toBe(VERSION);
  });

  it('only uses ANSI color on a TTY and respects NO_COLOR and --no-color', async () => {
    const esc = '\u001b[';
    mock.state.checkMode = 'fail';
    const args = ['check', 'https://example.com/post'];
    expect((await cli(args, authed())).stdout).not.toContain(esc);
    expect((await cli(args, { ...authed(), tty: true })).stdout).toContain(esc);
    expect((await cli(args, { ...authed({ NO_COLOR: '1' }), tty: true })).stdout).not.toContain(esc);
    expect((await cli([...args, '--no-color'], { ...authed(), tty: true })).stdout).not.toContain(esc);
  });
});
