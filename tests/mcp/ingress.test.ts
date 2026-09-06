import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RuntimeStore } from '../../src/v2/runtime.js';
import { defaultConfig } from '../../src/config/config.js';
import { ProjectRegistry } from '../../src/v2/registry.js';
import { McpIngress } from '../../src/mcp/ingress.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cm-mcp-'));
  const store = new RuntimeStore(root, { turnThreshold: 3 });
  cleanup.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const config = { ...defaultConfig(), dataRoot: root };
  const ingress = (clientId: string, accept = true) => new McpIngress(store, config, { clientId, workspaces: [], global: true, accept });
  return { store, ingress, root, config };
}
const input = { submissionId: 'e', conversationId: 's', contextId: 'global', text: '  Prefer concise replies.\n' };
it('isolates identities and status, but preserves cross-session scope batching', () => {
  const { store, ingress } = fixture(); const a = ingress('a'), b = ingress('b');
  a.submit(input); expect(b.status({ submissionId: 'e', conversationId: 's' })).toBeNull();
  b.submit(input);
  store.enqueue({ sessionId: 'pi-session', entryId: 'e', text: 'Pi user turn', scope: 'global', source: 'interactive', observedAt: new Date().toISOString() });
  const job = store.claim()!;
  expect(job.observations).toHaveLength(3);
  expect(new Set(job.observations.map(o => o.sessionId)).size).toBe(3);
  expect(job.observations.map(o => o.scope)).toEqual(['global', 'global', 'global']);
  expect(job.observations[0]!.text).toBe(input.text);
});
it('deduplicates, rejects conflicting payloads and never exposes bodies', () => {
  const { ingress } = fixture(); const a = ingress('a');
  expect(a.submit(input).duplicate).toBe(false);
  expect(a.submit(input).duplicate).toBe(true);
  expect(() => a.submit({ ...input, text: 'different' })).toThrow('SUBMISSION_CONFLICT');
  expect(a.status(input)).toEqual({ state: 'pending' });
});
it('requires local opt-in and validates context and cancellation before enqueue', () => {
  const { store, ingress } = fixture();
  expect(() => ingress('a', false).submit(input)).toThrow('SUBMISSION_DISABLED');
  expect(() => ingress('a').submit({ ...input, contextId: 'project:unknown' })).toThrow('CONTEXT_UNAVAILABLE');
  expect(() => ingress('a').submit(input, AbortSignal.abort())).toThrow('CANCELLED');
  expect(store.pending()).toHaveLength(0);
});
it('freezes registered project contexts and rejects removal or nested remapping', () => {
  const { root, config, store } = fixture();
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const child = join(workspace, 'child'); mkdirSync(child);
  const registry = new ProjectRegistry(root); const project = registry.register(workspace, 'Project');
  config.disclosure.allowedScopes = ['global', `project:${project.id}`];
  const ingress = new McpIngress(store, config, { clientId: 'a', workspaces: [child], global: false, accept: true });
  ingress.submit({ ...input, contextId: `project:${project.id}` });
  registry.register(child, 'Nested');
  expect(ingress.contexts()).toEqual([]);
  expect(() => ingress.submit({ ...input, submissionId: 'later', contextId: `project:${project.id}` })).toThrow();
  expect(store.pending()[0]!.scope).toBe(`project:${project.id}`);
  registry.remove(project.id);
  expect(ingress.contexts()).toEqual([]);
});
it('rejects empty and oversized complete turns without truncating or admitting them', () => {
  const { config, store } = fixture(); config.disclosure.maxTotalBytes = 4;
  const ingress = new McpIngress(store, config, { clientId: 'a', workspaces: [], global: true, accept: true });
  for (const text of ['', '   ', '汉字']) expect(() => ingress.submit({ ...input, text })).toThrow('INVALID_TEXT_SIZE');
  expect(store.pending()).toHaveLength(0);
});
it('preserves Pi-only cross-session batching and existing session-local context lookup', () => {
  const { store } = fixture();
  for (const [sessionId, entryId] of [['pi-a','a'], ['pi-b','b'], ['pi-a','c']]) store.enqueue({ sessionId: sessionId!, entryId: entryId!, text: entryId!, scope: 'global', source: 'interactive', observedAt: new Date().toISOString() });
  const job = store.claim()!; expect(job.observations).toHaveLength(3); store.finish(job);
  const next = store.enqueue({ sessionId: 'pi-a', entryId: 'd', text: 'd', scope: 'global', source: 'rpc', observedAt: new Date().toISOString() });
  expect(store.context(next).map(o => o.entryId)).toEqual(['a', 'c']);
});
it('does not infer a conversation from the connection', () => {
  const { store, ingress } = fixture(); const a = ingress('a');
  a.submit({ ...input, conversationId: undefined });
  a.submit({ ...input, submissionId: 'other', conversationId: undefined });
  expect(new Set(store.pending().map(o => o.sessionId)).size).toBe(2);
});
