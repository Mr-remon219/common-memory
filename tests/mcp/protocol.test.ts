import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { defaultConfig } from '../../src/config/config.js';
import { RuntimeStore } from '../../src/v2/runtime.js';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const entry = ['--import', resolve('tests/mcp/fixtures/source-loader.mjs'), resolve('src/cli/main.ts'), 'mcp'];
function fixture(baseUrl = 'http://127.0.0.1:1/v1', threshold = 6) {
  const home = mkdtempSync(join(tmpdir(), 'cm-wire-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const config = defaultConfig({ COMMON_MEMORY_HOME: home });
  config.remote = { provider: 'openai-compatible', model: 'fake', baseUrl, apiKeyEnv: 'CM_TEST_KEY' };
  config.scheduler.turnThreshold = threshold;
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  const env = { ...process.env, COMMON_MEMORY_HOME: home, CM_TEST_KEY: 'synthetic-key' } as Record<string, string>;
  return { home, config, env };
}
async function connect(env: Record<string, string>, clientId: string, accept = true, modern = false) {
  const client = new Client({ name: 'test', version: '1' }, modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
  const transport = new StdioClientTransport({ command: process.execPath, args: [...entry, '--client-id', clientId, '--global', ...(accept ? ['--accept-client-reported-user-turns'] : [])], env, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', b => { stderr += b; });
  cleanup.push(() => client.close());
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
}
const submission = { submissionId: 'one', conversationId: 'chat', contextId: 'global', text: 'Please prefer concise replies.' };
it.each([false, true])('serves real stdio, isolates identities and survives restart (modern=%s)', async modern => {
  const { env, config } = fixture();
  const a = await connect(env, 'a', true, modern), b = await connect(env, 'b');
  expect((await a.client.listTools()).tools.map(t => t.name)).toEqual(['memory_submit_user_turn', 'memory_status']);
  const call = await a.client.callTool({ name: 'memory_submit_user_turn', arguments: submission });
  expect(call.structuredContent).toMatchObject({ accepted: true, duplicate: false, state: 'pending' });
  expect((await b.client.callTool({ name: 'memory_status', arguments: { submissionId: 'one', conversationId: 'chat' } })).structuredContent).toEqual({ submission: null });
  expect((await a.client.callTool({ name: 'memory_submit_user_turn', arguments: { ...submission, source: 'rpc' } })).isError).toBe(true);
  expect((await a.client.callTool({ name: 'memory_submit_user_turn', arguments: { ...submission, text: 'different' } })).isError).toBe(true);
  await a.client.close(); await b.client.close();
  const again = await connect(env, 'a');
  expect((await again.client.callTool({ name: 'memory_submit_user_turn', arguments: submission })).structuredContent).toMatchObject({ duplicate: true });
  const store = new RuntimeStore(config.dataRoot);
  try { expect(store.db.prepare('SELECT COUNT(*) AS n FROM observations').get()!.n).toBe(1); } finally { store.close(); }
});
it('defaults to no submissions', async () => {
  const { env } = fixture(); const { client } = await connect(env, 'a', false);
  expect((await client.callTool({ name: 'memory_submit_user_turn', arguments: submission })).structuredContent).toEqual({ code: 'SUBMISSION_DISABLED' });
});
it('feeds the unchanged Writer through a real synthetic Responses server', async () => {
  let calls = 0;
  const provider = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const projection = JSON.parse(JSON.parse(body).input[1].content[0].text);
    calls++;
    const decision = { version: 'memory_maintenance_v2', request_id: projection.request_id, decisions: [{ kind: 'retain', admission: 'remember', lifetime: 'until_changed', applicability: 'global', confidence: 1, evidence: projection.observations.map((o: {ref: string}) => o.ref), reason: 'Synthetic preference', operations: [{ op: 'put_section', target: 'preferences', section: null, title: 'Replies', body: 'Prefer concise replies.\n' }] }] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'completed', incomplete_details: null, error: null, output: [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(decision), annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  cleanup.push(() => new Promise<void>(r => provider.close(() => r())));
  const port = (provider.address() as {port: number}).port;
  const { env, config } = fixture(`http://127.0.0.1:${port}/v1`, 1);
  const { client } = await connect(env, 'a');
  await client.callTool({ name: 'memory_submit_user_turn', arguments: submission });
  await expect.poll(async () => (await client.callTool({ name: 'memory_status', arguments: { submissionId: 'one', conversationId: 'chat' } })).structuredContent, { timeout: 8000 }).toEqual({ submission: { state: 'processed' } });
  expect(calls).toBe(1);
  expect(readFileSync(join(config.dataRoot, 'memory/preferences.md'), 'utf8')).toContain('Prefer concise replies.');
});
it('SIGTERM aborts in-flight model work and retains the durable submission', async () => {
  let received!: () => void;
  const requestStarted = new Promise<void>(r => { received = r; });
  const provider = createServer(async (req, _res) => { for await (const _chunk of req) { /* drain synthetic request */ } received(); });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  cleanup.push(() => { provider.closeAllConnections(); return new Promise<void>(r => provider.close(() => r())); });
  const { env, config } = fixture(`http://127.0.0.1:${(provider.address() as {port: number}).port}/v1`, 1);
  const { client, transport } = await connect(env, 'terminate');
  await client.callTool({ name: 'memory_submit_user_turn', arguments: submission });
  await requestStarted;
  const closed = new Promise<void>(r => { client.onclose = r; });
  process.kill(transport.pid!, 'SIGTERM'); await closed;
  const store = new RuntimeStore(config.dataRoot);
  try {
    expect(store.status().jobs).toContainEqual(expect.objectContaining({ state: 'retry' }));
    expect(store.db.prepare('SELECT text,state FROM observations').get()).toMatchObject({ text: submission.text, state: 'claimed' });
  } finally { store.close(); }
});
it('exits on stdin EOF without protocol output pollution', async () => {
  const { env } = fixture();
  const child = spawn(process.execPath, [...entry, '--client-id', 'eof'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  cleanup.push(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = ''; child.stdout.on('data', b => { stdout += b; });
  child.stderr.resume(); const exited = once(child, 'exit'); child.stdin.end();
  expect((await exited)[0]).toBe(0); expect(stdout).toBe('');
});
