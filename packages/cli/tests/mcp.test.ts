import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/api.js';
import { handleMessage, TOOLS, type McpDeps } from '../src/commands/mcp.js';

function deps(calls: { method: string; url: string; body?: unknown }[]): McpDeps {
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ ok: true, job_id: 'job_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { api: new ApiClient({ baseUrl: 'http://x.test', apiKey: 'pb_live_test', fetch }), resolveSite: async (s) => s ?? 'site_1' };
}

describe('mcp server', () => {
  it('initializes and echoes a supported protocol version', async () => {
    const r = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, deps([]));
    expect(r).toMatchObject({ id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'paperboy' } } });
  });

  it('answers notifications with nothing and unknown methods with an error', async () => {
    expect(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps([]))).toBeNull();
    expect(await handleMessage({ jsonrpc: '2.0', id: 2, method: 'nope' }, deps([]))).toMatchObject({ error: { code: -32601 } });
  });

  it('lists every tool with a schema and a read-only hint', async () => {
    const r = (await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, deps([]))) as { result: { tools: { name: string; inputSchema: unknown; annotations: { readOnlyHint: boolean } }[] } };
    expect(r.result.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(r.result.tools.every((t) => t.inputSchema && typeof t.annotations.readOnlyHint === 'boolean')).toBe(true);
    const writes = r.result.tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name);
    expect(writes).toEqual(['write_article', 'publish_article']);
  });

  it('write_article never asks the server to publish', async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const r = (await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'write_article', arguments: { site: 'site_9', topic: 'how to pick a CRM' } } }, deps(calls))) as { result: { content: { text: string }[] } };
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'http://x.test/api/v1/sites/site_9/articles', body: { publish: false, topic: 'how to pick a CRM' } });
    expect(JSON.parse(r.result.content[0]!.text)).toMatchObject({ job_id: 'job_1' });
  });

  it('reports tool failures as isError results, not protocol errors', async () => {
    const r = await handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_job', arguments: {} } }, deps([]));
    expect(r).toMatchObject({ id: 5, result: { isError: true } });
    expect(await handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'missing' } }, deps([]))).toMatchObject({ error: { code: -32602 } });
  });
});
