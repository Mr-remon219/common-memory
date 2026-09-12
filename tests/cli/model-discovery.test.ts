import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/config/config.js';
import { PROVIDERS, modelApi, type ProviderPreset } from '../../src/config/providers.js';
import { discoverModels } from '../../src/cli/model-discovery.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cm-model-list-')); vi.stubEnv('COMMON_MEMORY_HOME', home); vi.stubEnv('NO_PROXY', ''); vi.stubEnv('no_proxy', ''); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
const key = 'synthetic-private-key';
const response = (ids: unknown[]) => new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), { status: 200 });

it.each(PROVIDERS.filter(p => p.id !== 'custom'))('performs one authenticated models request on each explicit $id entry, without memory or billing', async provider => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(['gpt-synthetic', 'glm-synthetic'])).mockResolvedValueOnce(response(['gpt-new', 'glm-new']));
  const config = defaultConfig(); config.remote.proxy = { mode: 'direct' };
  const first = await discoverModels(provider, key, config, { fetch });
  const second = await discoverModels(provider, key, config, { fetch });
  expect(fetch).toHaveBeenCalledTimes(2); expect(first).not.toEqual(second);
  expect(fetch.mock.calls[0]).toEqual([`${provider.baseUrl}/models`, expect.objectContaining({ method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } })]);
  expect(fetch.mock.calls[0]![1]!.body).toBeUndefined();
  expect(existsSync(join(home, 'data'))).toBe(false);
});
it('never discovers Custom or submits an empty key', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  await expect(discoverModels(PROVIDERS[6], key, defaultConfig(), { fetch })).rejects.toThrow('Custom');
  await expect(discoverModels(PROVIDERS[0], '', defaultConfig(), { fetch })).rejects.toThrow('API Key');
  expect(fetch).not.toHaveBeenCalled();
});
it('deduplicates, sorts and rejects unsafe/non-text model IDs', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(['z-model', 'a-model', 'a-model', '', null, 'bad\nname', 'bad\x1b[2J', 'text-embedding-3-small', 'audio-transcribe']));
  const models = await discoverModels(PROVIDERS[0], key, defaultConfig(), { fetch });
  expect(models.map(m => m.id)).toEqual(['a-model', 'z-model']);
});
it('does not send Anthropic-only Go models to a guessed Chat endpoint', () => {
  expect(modelApi('opencode-go', 'minimax-m3')).toBeNull();
  expect(modelApi('opencode-go', 'qwen3.8-max')).toBeNull();
  expect(modelApi('opencode-go', 'unknown-model')).toBeNull();
  expect(modelApi('opencode-go', 'glm-5.3')).toBe('chat_completions');
  expect(modelApi('opencode-go', 'gpt-5.6-luna')).toBe('responses');
});
it.each([401, 403, 404, 429, 500])('HTTP %s errors never echo the server body or key', async status => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(`private:${key}`, { status }));
  await expect(discoverModels(PROVIDERS[0], key, defaultConfig(), { fetch })).rejects.toThrow(/模型/);
  try { await discoverModels(PROVIDERS[0], key, defaultConfig(), { fetch }); } catch (error) { expect(String(error)).not.toContain(key); }
});
it.each(['bad-json', JSON.stringify({ data: [] }), JSON.stringify({ unexpected: key }), 'x'.repeat(1_048_577)])('fails closed for an invalid/empty/oversized response', async body => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body));
  await expect(discoverModels(PROVIDERS[0], key, defaultConfig(), { fetch })).rejects.toThrow();
});
it('cancels a non-cooperative body read without exposing transport errors', async () => {
  const controller = new AbortController();
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => { controller.abort(); return new Response(new ReadableStream({ start() {} })); });
  await expect(discoverModels(PROVIDERS[0], key, defaultConfig(), { fetch, signal: controller.signal })).rejects.toThrow('已取消');
});
it('uses an isolated real network client and rejects credential-forwarding redirects', async () => {
  const { createServer } = await import('node:http');
  let hits = 0;
  const server = createServer((req, res) => { hits++; expect(req.url).toBe('/v1/models'); res.writeHead(302, { location: '/stolen' }); res.end(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const provider = { ...PROVIDERS[0], baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` } as ProviderPreset;
  const config = defaultConfig(); config.remote.proxy = { mode: 'direct' };
  try { await expect(discoverModels(provider, key, config)).rejects.toThrow('模型发现失败'); expect(hits).toBe(1); }
  finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});
it('legacy absent proxy remains absent during discovery and never becomes explicit env mode',async()=>{
 const config=defaultConfig();delete config.remote.proxy;
 vi.stubEnv('HTTPS_PROXY','bad-secret');vi.stubEnv('https_proxy',undefined);vi.stubEnv('NO_PROXY','malformed/private');vi.stubEnv('no_proxy',undefined);
 const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(['gpt-synthetic']));
 expect(await discoverModels(PROVIDERS[0],key,config,{fetch})).toHaveLength(1);expect(config.remote).not.toHaveProperty('proxy');
});
