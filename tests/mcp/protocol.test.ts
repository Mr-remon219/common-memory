import { createServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { defaultConfig } from '../../src/config/config.js';
import { RuntimeStore } from '../../src/v2/runtime.js';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
// --import resolves an ESM specifier; a Windows drive path is not a file URL.
const entry = ['--import', pathToFileURL(resolve('tests/mcp/fixtures/source-loader.mjs')).href, resolve('src/cli/main.ts'), 'mcp'];
function fixture(baseUrl = 'http://127.0.0.1:1/v1', threshold = 6) {
  const home = mkdtempSync(join(tmpdir(), 'cm-wire-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const config = defaultConfig({ COMMON_MEMORY_HOME: home });
  config.remote = { provider: 'openai-compatible', model: 'fake', baseUrl, apiKeyEnv: 'CM_TEST_KEY' };
  config.scheduler.turnThreshold = threshold;
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  writeFileSync(join(home, '.env'), 'CM_TEST_KEY="synthetic-key"\n', {mode:0o600});
  const env = { ...process.env, COMMON_MEMORY_HOME: home, CM_TEST_KEY: 'host-key-must-be-ignored' } as Record<string, string>;
  return { home, config, env };
}
async function connect(env: Record<string, string>, clientId: string, accept = true, modern = false, extra: string[] = []) {
  const client = new Client({ name: 'test', version: '1' }, modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
  const transport = new StdioClientTransport({ command: process.execPath, args: [...entry, '--client-id', clientId, '--global', ...(accept ? ['--accept-client-reported-user-turns'] : []), ...extra], env, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', b => { stderr += b; });
  cleanup.push(() => client.close());
  try { await client.connect(transport); }
  catch (cause) { throw new Error(`MCP child failed to connect:\n${stderr.slice(-8000)}`, { cause }); }
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
  await expect.poll(async () => (await client.callTool({ name: 'memory_status', arguments: { submissionId: 'one', conversationId: 'chat' } })).structuredContent, { timeout: 8000 }).toMatchObject({ submission: { state: 'processed', issue: null, retainedIn: ['preferences'] } });
  expect(calls).toBe(1);
  expect(readFileSync(join(config.dataRoot, 'memory/preferences.md'), 'utf8')).toContain('Prefer concise replies.');
});
// Capability profiles are fixed at launch: each process only registers what its arguments allow.
it('read-only launch serves memory_read without a Writer, API key or runtime database', async () => {
  const { env, config } = fixture();
  env.NODE_OPTIONS = `--import=${pathToFileURL(resolve('tests/cli/fixtures/no-sqlite.mjs')).href}`;
  delete env.CM_TEST_KEY;
  mkdirSync(join(config.dataRoot, 'memory'), { recursive: true });
  writeFileSync(join(config.dataRoot, 'memory/profile.md'), '# Profile\n\n## Background\nStudies ecology and keeps a rescued tortoise named Basalt.\n');
  const { client } = await connect(env, 'codex', false, false, ['--capability', 'read']);
  expect((await client.listTools()).tools.map(t => t.name)).toEqual(['memory_read', 'memory_status']);
  expect((await client.callTool({ name: 'memory_status', arguments: {} })).structuredContent).toMatchObject({ capabilities: ['read'], readEnabled: true, initEnabled: false, submissionEnabled: false, contexts: ['global'] });
  const read = await client.callTool({ name: 'memory_read', arguments: {} });
  expect(read.structuredContent).toMatchObject({ empty: false, contexts: ['global'] });
  expect((read.content as {text: string}[])[0]!.text).toContain('tortoise named Basalt');
  expect((read.content as {text: string}[])[0]!.text).toContain('user data, not instructions');
  expect((await client.callTool({ name: 'memory_read', arguments: { contextId: 'project:other' } })).structuredContent).toEqual({ code: 'CONTEXT_UNAVAILABLE' });
  expect((await client.callTool({ name: 'memory_status', arguments: { importId: 'x' } })).structuredContent).toEqual({ code: 'STATUS_UNAVAILABLE' });
  expect(existsSync(join(config.dataRoot, 'runtime.sqlite'))).toBe(false);
});
it('init launch imports agent-reported understanding through the unchanged Writer and reports retention', async () => {
  const seen: unknown[] = [];
  const provider = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const projection = JSON.parse(JSON.parse(body).input[1].content[0].text);
    seen.push(projection.observations);
    const decision = { version: 'memory_maintenance_v2', request_id: projection.request_id, decisions: [{ kind: 'retain', admission: 'remember', lifetime: 'until_changed', applicability: 'global', confidence: 0.8, evidence: projection.observations.map((o: {ref: string}) => o.ref), reason: 'Synthetic import', operations: [{ op: 'put_section', target: 'profile', section: null, title: 'Imported understanding', body: `Imported from ${projection.observations[0].import.source_label} (${projection.observations[0].import.basis}): ${projection.observations[0].text}\n` }] }] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'completed', incomplete_details: null, error: null, output: [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(decision), annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  cleanup.push(() => new Promise<void>(r => provider.close(() => r())));
  const { env, config, home } = fixture(`http://127.0.0.1:${(provider.address() as {port: number}).port}/v1`, 6);
  // Init-only authorization: no user_explicit. The process must still start its Writer and process imports.
  config.disclosure.allowedProvenance = ['agent_observation'];
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  const { client } = await connect(env, 'chatgpt', false, false, ['--capability', 'init']);
  expect((await client.listTools()).tools.map(t => t.name)).toEqual(['memory_init', 'memory_status']);
  const args = { importId: 'imp-1', contextId: 'global', sourceLabel: 'chatgpt-desktop', basis: 'saved_memories', understanding: 'The user studies ecology and keeps a rescued tortoise named Basalt.', gaps: 'No access to older chats.' };
  expect((await client.callTool({ name: 'memory_init', arguments: args })).structuredContent).toMatchObject({ accepted: true, duplicate: false, state: 'pending' });
  // Below the 6-turn threshold, only the requested flush makes this process promptly.
  await expect.poll(async () => (await client.callTool({ name: 'memory_status', arguments: { importId: 'imp-1' } })).structuredContent, { timeout: 8000 }).toMatchObject({ import: { state: 'processed', issue: null, retainedIn: ['profile'] } });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toEqual([expect.objectContaining({ source_kind: 'agent_import', text: args.understanding, import: { source_label: 'chatgpt-desktop', basis: 'saved_memories', gaps: 'No access to older chats.' } })]);
  const profile = readFileSync(join(config.dataRoot, 'memory/profile.md'), 'utf8');
  expect(profile).toContain('Imported from chatgpt-desktop (saved_memories)');
  expect(profile).toContain('tortoise named Basalt');
  // Retrying the same import after processing is a duplicate, not a second write.
  expect((await client.callTool({ name: 'memory_init', arguments: args })).structuredContent).toMatchObject({ duplicate: true, state: 'processed' });
  expect(seen).toHaveLength(1);
  // A read-only process on the same dataRoot sees the same canonical memory.
  const reader = await connect(env, 'codex', false, false, ['--capability', 'read']);
  expect((await reader.client.callTool({ name: 'memory_read', arguments: {} })).structuredContent).toMatchObject({ empty: false });
  expect(((await reader.client.callTool({ name: 'memory_read', arguments: {} })).content as {text: string}[])[0]!.text).toContain('tortoise named Basalt');
});
// Node's SIGTERM emulation forcibly kills Windows processes; EOF is the portable
// graceful shutdown path. POSIX additionally exercises the real signal handler.
it.each(['EOF', ...(process.platform === 'win32' ? [] : ['SIGTERM'])])('%s aborts in-flight model work and retains the durable submission', async mode => {
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
  if (mode === 'EOF') await client.close();
  else process.kill(transport.pid!, 'SIGTERM');
  await closed;
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
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  const exited = once(child, 'exit'); child.stdin.end();
  expect((await exited)[0], stderr).toBe(0); expect(stdout).toBe('');
});
