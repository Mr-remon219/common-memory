import { toolProvider, sendTools } from '../helpers/tool-provider.js';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, saveApiKeyToEnvFile,saveConfig,type CommonMemoryConfig } from '../../src/config/config.js';
import { startTestService } from '../helpers/service-daemon.js';
import { modifyMemory } from '../../src/cli/modify-memory.js';
import { RuntimeStore } from '../../src/v2/runtime.js';
import { ProjectRegistry } from '../../src/v2/registry.js';

type Projection = {
  request_id: string;
  observations: { ref: string; text: string; source_kind: string; source_scope: string }[];
  documents: { target: string; sections: { ref: string; title: string }[] }[];
};
let home:string,config:CommonMemoryConfig,server:Server,stopService:()=>Promise<void>;
let decide: (projection: Projection) => unknown;
let seen: Projection[];
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'cm-modify-'));
  vi.stubEnv('COMMON_MEMORY_HOME', home); saveApiKeyToEnvFile('CM_MODIFY_KEY', 'synthetic-key');
  seen = [];
  decide = projection => decision(projection, 'ignore');
  const explore = toolProvider();
  server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const wire = JSON.parse(raw);
    const projection = explore(wire, res) as Projection | null; if (!projection) return;
    seen.push(projection);
    const body = decide(projection);
    sendTools(res, wire, [{name:'submit_memory_decision',args:body}]);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  config = defaultConfig({ COMMON_MEMORY_HOME: home });
  config.remote = { provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: 'synthetic', api: 'chat_completions', apiKeyEnv: 'CM_MODIFY_KEY', proxy: { mode: 'direct' } };config.scheduler.leaseMs=100;saveConfig(config);stopService=await startTestService(home);
});
afterEach(async () => {
  await stopService();server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true });
});
function decision(projection: Projection, kind: 'retain' | 'forget' | 'ignore', operations: unknown[] = [], applicability = 'global') {
  return { edit_result:kind === 'ignore' ? 'already_satisfied' : 'modified', version: 'memory_maintenance_v2', request_id: projection.request_id, decisions: [{
    kind, applicability, confidence: 1, evidence: projection.observations.map(o => o.ref), reason: 'synthetic test',
    ...(kind === 'retain' ? { admission: 'correct', lifetime: 'until_changed' } : {}),
    ...(kind === 'ignore' ? {} : { operations }),
  }] };
}
function inspect<T>(fn: (store: RuntimeStore) => T): T {
  const store = new RuntimeStore(config.dataRoot); try { return fn(store); } finally { store.close(); }
}

it('sends user evidence through the real configured Writer and Core for retain, correction and forget', async () => {
  let phase = 0;
  decide = projection => {
    const section = projection.documents.find(d => d.target === 'preferences')!.sections[0]?.ref ?? null;
    return decision(projection, phase === 2 ? 'forget' : 'retain', phase === 2
      ? [{ op: 'remove_section', target: 'preferences', section }]
      : [{ op: 'put_section', target: 'preferences', section, title: 'Editor', body: phase ? 'Uses Pi.' : 'Uses Cursor Ultra.' }]);
  };
  const first = await modifyMemory(config, 'I use Cursor Ultra.');
  expect(first.complete).toBe(true);
  expect(first.outcome.retainedIn).toEqual(['preferences']);
  phase = 1;
  expect((await modifyMemory(config, 'I no longer use Cursor Ultra. I use Pi.')).complete).toBe(true);
  const path = join(config.dataRoot, 'memory/preferences.md');
  expect(readFileSync(path, 'utf8')).toContain('Uses Pi.'); expect(readFileSync(path, 'utf8')).not.toContain('Cursor');
  phase = 2;
  expect((await modifyMemory(config, 'Forget my editor preference.')).complete).toBe(true);
  expect(readFileSync(path, 'utf8')).not.toContain('## Editor');
  expect(seen.map(p => p.observations[0]!.source_kind)).toEqual(['user_turn', 'user_turn', 'user_turn']);
  expect(seen[1]!.observations[0]!.text).toBe('I no longer use Cursor Ultra. I use Pi.');
  expect(inspect(store => store.db.prepare('SELECT text FROM observations').all()).every(row => row.text === null)).toBe(true);
});

it('reports explicitly already satisfied without forcing a write', async () => {
  const result = await modifyMemory(config, 'A transient request');
  expect(result.complete).toBe(true); expect(result.outcome.retainedIn).toEqual([]);
  expect(existsSync(join(config.dataRoot, 'memory/profile.md'))).toBe(false);
});

it.each(['provenance', 'read', 'write', 'empty', 'secret', 'oversized', 'excerpt', 'cancelled'])('rejects %s before creating data or sending a request', async reason => {
  let prompt = 'A synthetic change'; const controller = new AbortController();
  if (reason === 'provenance') config.disclosure.allowedProvenance = ['document_import'];
  if (reason === 'read') config.disclosure.allowedScopes = ['project:other'];
  if (reason === 'write') config.writableScopes = [];
  if (reason === 'empty') prompt = '  ';
  if (reason === 'secret') prompt = 'password=verysecret';
  if (reason === 'oversized') { config.disclosure.maxTotalBytes=131072; prompt = 'a'.repeat((config.disclosure.maxExcerptBytes ?? 131072) + 1); }
  if (reason === 'excerpt') config.disclosure.maxExcerptBytes = 8;
  if (reason === 'cancelled') controller.abort();
  await expect(modifyMemory(config, prompt, { signal: controller.signal })).rejects.toThrow();
  expect(inspect(store=>store.status().observations)).toEqual([]);expect(seen).toHaveLength(0);
});

it('keeps failed requests durably recoverable and never returns a malformed decision as success', async () => {
  decide = () => ({ unexpected: true });
  const result = await modifyMemory(config, 'A durable correction');
  expect(result.complete).toBe(false); expect(result.outcome.jobState).toBe('paused');
  expect(inspect(store => store.db.prepare('SELECT text,source FROM observations').get())).toEqual({ text: 'A durable correction', source: 'interactive' });
  expect(existsSync(join(config.dataRoot, 'memory/preferences.md'))).toBe(false);
});

it('a prior lease cannot make the newly submitted request look processed', async () => {
  inspect(store => {
    store.enqueue({ sessionId: 'other', entryId: '1', text: 'Older work', source: 'interactive', scope: 'global', observedAt: new Date().toISOString() });
    const old=store.claim({force:true})!;store.db.prepare('UPDATE jobs SET expires=0 WHERE id=?').run(old.id);
  });
  const result=await modifyMemory(config,'A new change');expect(result.outcome.state).toBe('processed');expect(seen.some(projection=>projection.observations.some(row=>row.text==='A new change'))).toBe(true);
});

it('stops after this request, rather than draining work that arrived later', async () => {
  decide = projection => {
    inspect(store => store.enqueue({ sessionId: 'later', entryId: '1', text: 'Later work', source: 'interactive', scope: 'global', observedAt: new Date().toISOString() }));
    return decision(projection, 'ignore');
  };
  expect((await modifyMemory(config, 'This request')).complete).toBe(true);
  const deadline=Date.now()+3000;while(seen.length<2&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));expect(seen.length).toBeGreaterThanOrEqual(2);
});

it('cancels an in-flight request without deleting it and restores process signal listeners', async () => {
  const controller = new AbortController();
  const counts = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  decide = projection => { controller.abort(); return decision(projection, 'ignore'); };
  const result = await modifyMemory(config, 'Keep pending on cancellation', { signal: controller.signal });
  expect(result.cancelled).toBe(true); expect(result.complete).toBe(false);
  expect(inspect(store => store.db.prepare('SELECT text FROM observations').get())!.text).toBe('Keep pending on cancellation');
  expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(counts);
});

it('explicit project requests keep their registered scope and cannot write another project', async () => {
  const registry = new ProjectRegistry(config.dataRoot), a = registry.register(home, 'A');
  const scope = `project:${a.id}`;
  config.disclosure.allowedScopes = [...config.disclosure.allowedScopes, scope];config.writableScopes=[...config.writableScopes,scope];saveConfig(config);await stopService();stopService=await startTestService(home);
  decide = projection => decision(projection, 'retain', [{ op: 'put_section', target: scope, section: null, title: 'Project', body: 'Project constraint.' }], 'project');
  expect((await modifyMemory(config, 'Update this project', { workspace: home })).complete).toBe(true);
  expect(seen[0]!.observations[0]!.source_scope).toBe(scope);
  expect(readFileSync(join(config.dataRoot, 'memory/projects', `${a.id}.md`), 'utf8')).toContain('Project constraint.');
  decide = projection => decision(projection, 'retain', [{ op: 'put_section', target: 'project:other', section: null, title: 'Other', body: 'Forbidden.' }], 'project');
  expect((await modifyMemory(config, 'Another correction', { workspace: home })).complete).toBe(false);
  expect(existsSync(join(config.dataRoot, 'memory/projects/other.md'))).toBe(false);
});
