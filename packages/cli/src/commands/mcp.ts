import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { ApiClient } from '../api.js';
import type { Context } from '../context.js';
import { CliError } from '../errors.js';
import { resolveSiteId } from '../site.js';
import { VERSION } from '../version.js';

/**
 * `paperboy mcp`: a Model Context Protocol server over stdio. It exposes the REST API as tools, with the same
 * key and base URL as the rest of the CLI. Messages are newline-delimited JSON-RPC 2.0 on stdin and stdout;
 * logs go to stderr. No SDK: the protocol surface used here is small.
 */

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

type Args = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
  run(args: Args, deps: McpDeps): Promise<unknown>;
}

export interface McpDeps {
  api: ApiClient;
  /** Turns a site id, a domain or nothing (saved default, or the only site) into a site id. */
  resolveSite(site: string | undefined): Promise<string>;
}

const site = { type: 'string', description: 'Site id or domain. Optional when the account has one site or a default is saved.' };
const str = (args: Args, key: string): string | undefined => {
  const v = args[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};
const whole = (args: Args, key: string, fallback: number, max: number): number => {
  const v = args[key];
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max ? v : fallback;
};
const need = (args: Args, key: string): string => {
  const v = str(args, key);
  if (!v) throw new CliError('usage', `"${key}" is required.`);
  return v;
};
const enc = encodeURIComponent;

export const TOOLS: Tool[] = [
  {
    name: 'list_sites',
    description: 'List the sites on this Paperboy account, with publish target and Search Console state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async (_a, d) => (await d.api.get('/api/v1/sites')).data,
  },
  {
    name: 'suggest_topics',
    description: 'Suggest articles worth writing next, from Search Console data, with the reason and signals for each.',
    inputSchema: { type: 'object', properties: { site, n: { type: 'integer', minimum: 1, maximum: 50, description: 'How many topics. Default 5.' } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async (a, d) => (await d.api.post(`/api/v1/sites/${enc(await d.resolveSite(str(a, 'site')))}/topics`, { n: whole(a, 'n', 5, 50) })).data,
  },
  {
    name: 'write_article',
    description:
      'Start writing an article: research, write, fact check. This spends money on the Anthropic key the server uses. Returns a job id at once; poll get_job. Whether the article publishes by itself follows the site approval setting, so ask the user before calling this on a site set to autopilot.',
    inputSchema: {
      type: 'object',
      properties: {
        site,
        topic_id: { type: 'string', description: 'A topic id from suggest_topics.' },
        topic: { type: 'string', description: 'Free text topic, used when there is no topic id.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: async (a, d) => {
      const body: Args = { publish: false };
      const id = str(a, 'topic_id');
      const text = str(a, 'topic');
      if (id) body['topic_id'] = id;
      else if (text) body['topic'] = text;
      const path = `/api/v1/sites/${enc(await d.resolveSite(str(a, 'site')))}/articles`;
      return (await d.api.post(path, body, { idempotencyKey: randomUUID() })).data;
    },
  },
  {
    name: 'get_job',
    description: 'Status of a job started by write_article: queued, running, done or failed, with the current step and the article id when done.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'], additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async (a, d) => (await d.api.get(`/api/v1/jobs/${enc(need(a, 'job_id'))}`)).data,
  },
  {
    name: 'get_article',
    description: 'An article with its status, URL and the fact-check verdict: every check, and each held claim with the problem found.',
    inputSchema: { type: 'object', properties: { article_id: { type: 'string' } }, required: ['article_id'], additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async (a, d) => (await d.api.get(`/api/v1/articles/${enc(need(a, 'article_id'))}`)).data,
  },
  {
    name: 'fact_check',
    description:
      'Fact check a page URL or a Markdown draft. Every cited link is fetched and each claim is compared with the text of the page it cites. Returns pass, a score and one entry per claim: verified, held, unsupported or mismatch.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'A public page to check.' },
        markdown: { type: 'string', description: 'A draft in Markdown, with its sources linked inline.' },
        sources: { type: 'array', items: { type: 'string' }, description: 'Extra source URLs to read.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (a, d) => {
      const body: Args = {};
      if (str(a, 'url')) body['url'] = str(a, 'url');
      else if (str(a, 'markdown')) body['markdown'] = str(a, 'markdown');
      else throw new CliError('usage', 'Send "url" or "markdown".');
      if (Array.isArray(a['sources'])) body['sources'] = a['sources'].filter((s): s is string => typeof s === 'string');
      return (await d.api.post('/api/v1/fact-check', body, { idempotencyKey: randomUUID(), timeoutMs: 120_000 })).data;
    },
  },
  {
    name: 'publish_article',
    description: 'Publish an article that passed the fact check to the site publish target (WordPress, Ghost or webhook). This makes it public: confirm with the user first.',
    inputSchema: { type: 'object', properties: { article_id: { type: 'string' } }, required: ['article_id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (a, d) => (await d.api.post(`/api/v1/articles/${enc(need(a, 'article_id'))}/publish`, {})).data,
  },
  {
    name: 'get_performance',
    description: 'Search Console totals (clicks, impressions, average position) and daily rows for a site.',
    inputSchema: { type: 'object', properties: { site, days: { type: 'integer', minimum: 1, maximum: 365, description: 'Window in days. Default 28.' } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async (a, d) => (await d.api.get(`/api/v1/sites/${enc(await d.resolveSite(str(a, 'site')))}/performance`, { query: { days: whole(a, 'days', 28, 365) } })).data,
  },
];

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Args;
}

const ok = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const fail = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** Handles one JSON-RPC message. Returns the response, or null for notifications. */
export async function handleMessage(msg: Rpc, deps: McpDeps): Promise<Record<string, unknown> | null> {
  const { id, method, params = {} } = msg;
  if (typeof method !== 'string') return id === undefined ? null : fail(id, -32600, 'Invalid request.');
  if (id === undefined) return null; // notifications/initialized, notifications/cancelled, and so on

  switch (method) {
    case 'initialize': {
      const asked = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '';
      return ok(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'paperboy', version: VERSION },
        instructions: 'Paperboy writes and fact checks SEO articles. write_article spends money and publish_article makes content public: ask the user first.',
      });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params['name']);
      if (!tool) return fail(id, -32602, `Unknown tool "${String(params['name'])}".`);
      const args = params['arguments'] && typeof params['arguments'] === 'object' ? (params['arguments'] as Args) : {};
      try {
        const data = await tool.run(args, deps);
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
      } catch (err) {
        return ok(id, { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] });
      }
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

export async function mcp(ctx: Context): Promise<number> {
  const api = ctx.client({ timeoutMs: 130_000 });
  const deps: McpDeps = {
    api,
    resolveSite: (s) => resolveSiteId(s ? { ...ctx, settings: { ...ctx.settings, site: s } } : ctx),
  };
  const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\n');
  process.stderr.write(`paperboy mcp ${VERSION} ready on stdio (${ctx.settings.baseUrl})\n`);

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: Rpc;
    try {
      msg = JSON.parse(line) as Rpc;
    } catch {
      send(fail(null, -32700, 'Parse error.'));
      continue;
    }
    // Tool calls can take minutes: do not hold up other requests.
    const job = handleMessage(msg, deps).then((res) => {
      if (res) send(res);
    });
    pending.add(job);
    void job.finally(() => pending.delete(job));
  }
  await Promise.all(pending);
  return 0;
}
