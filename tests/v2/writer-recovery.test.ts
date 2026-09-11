import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeStore } from '../../src/v2/runtime.js';
import { SessionIngress } from '../../src/v2/session.js';
import { Writer } from '../../src/v2/writer.js';
import { readAuthorizedMemory } from '../../src/v2/reader.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

it('recovers files-before-DB process death into source links and session completion, without another model call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-writer-recovery-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStore(root);
  const ingress = new SessionIngress(store);
  const key = ingress.open({ client: 'pi', processInstance: 'synthetic', sessionId: 'recovery' });
  const user = { id: 'user', turnId: 'turn', role: 'user' as const, text: 'Synthetic background and preference.', scope: 'global', source: 'interactive', observedAt: '2026-09-09T00:00:00Z' };
  const assistant = { ...user, id: 'assistant', role: 'assistant' as const, text: 'Synthetic context, not evidence.', source: 'conversation_context' };
  ingress.capture(key, user);
  ingress.capture(key, assistant);
  ingress.settle(key, 'turn');
  ingress.end(key);
  store.close();

  const script = `
    import { Writer } from ${JSON.stringify(new URL('../../src/v2/writer.ts', import.meta.url).href)};
    const writer = new Writer({
      dataRoot: ${JSON.stringify(root)}, allowedScopes: ['global'],
      checkpoint: () => process.exit(73),
      model: { async analyze(request) {
        return { kind: 'output', usage: {}, body: {
          version: 'memory_maintenance_v2', request_id: request.projection.request_id,
          decisions: [{ kind: 'retain', admission: 'remember', lifetime: 'stable',
            applicability: 'global', confidence: 1, evidence: [request.projection.observations[0].ref],
            reason: 'PRIVATE_MODEL_RATIONALE', operations: [
              { op: 'put_section', target: 'profile', section: null, title: 'Background', body: 'Synthetic background.' },
              { op: 'put_section', target: 'preferences', section: null, title: 'Style', body: 'Synthetic preference.' }
            ] }]
        } };
      } }
    });
    await writer.run();
    process.exit(74);
  `;
  const child = spawnSync(process.execPath, [
    '--import', new URL('../mcp/fixtures/source-loader.mjs', import.meta.url).href,
    '--input-type=module', '-e', script,
  ], { encoding: 'utf8', timeout: 10000 });
  expect(child.status, child.stderr).toBe(73);

  // Verify the actual crash window before Writer's startup recovery can conceal it.
  const crashed = new RuntimeStore(root);
  let sourceId: number;
  try {
    const observation = crashed.db.prepare('SELECT id,state,text FROM observations').get()!;
    sourceId = Number(observation.id);
    expect(observation).toMatchObject({ state: 'claimed', text: user.text });
    expect(crashed.db.prepare('SELECT COUNT(*) AS n FROM receipts').get()!.n).toBe(0);
    expect(new SessionIngress(crashed).status(key)).toMatchObject({ complete: false, pending: 1 });
    expect(readAuthorizedMemory({ dataRoot: root, contexts: ['global'] }).documents.map(d => d.content))
      .toEqual(['# Profile\n\n## Background\nSynthetic background.\n', '# Preferences\n\n## Style\nSynthetic preference.\n']);
  } finally { crashed.close(); }

  const analyze = vi.fn(() => { throw new Error('Recovery must not ask the model again'); });
  const options = { dataRoot: root, allowedScopes: ['global'], model: { analyze } };
  const sourceKey = (target: string, title: string) => `${target}:${createHash('sha256').update(title).digest('hex')}`;
  for (let restart = 0; restart < 2; restart++) {
    const recovered = new Writer(options);
    try {
      expect(await recovered.run()).toEqual({ outcome: 'idle' });
      expect(new SessionIngress(recovered.store).status(key)).toEqual({ closing: true, complete: true, pending: 0, failed: 0, batches: 1 });
      expect(recovered.store.sources(sourceKey('profile', 'Background'))).toEqual([sourceId]);
      expect(recovered.store.sources(sourceKey('preferences', 'Style'))).toEqual([sourceId]);
      expect(recovered.store.db.prepare('SELECT COUNT(*) AS n FROM receipts').get()!.n).toBe(1);
      expect(recovered.store.status().jobs).toHaveLength(1);
      expect(recovered.store.status().jobs[0]!.state).toBe('done');
    } finally { recovered.close(); }
  }
  expect(analyze).not.toHaveBeenCalled();
  const files = readdirSync(join(root, 'runtime/receipts'));
  expect(files).toHaveLength(1);
  const receipt = readFileSync(join(root, 'runtime/receipts', files[0]!), 'utf8');
  for (const privateText of [user.text, assistant.text, 'PRIVATE_MODEL_RATIONALE', 'Background', 'Synthetic preference.']) {
    expect(receipt).not.toContain(privateText);
  }
  expect(readdirSync(join(root, 'runtime/transactions'))).toEqual([]);

  // Recovered links must work, not just exist: forgetting purges the original user
  // body AND its assistant context, and replay cannot resurrect either one.
  const forgetting = new Writer({ ...options, model: { async analyze(request) {
    return { kind: 'output', usage: {}, body: {
      version: 'memory_maintenance_v2', request_id: request.projection.request_id,
      decisions: [{ kind: 'forget', applicability: 'global', confidence: 1,
        evidence: (request.projection.observations as { ref: string }[]).map(o => o.ref), reason: 'Synthetic forget',
        operations: ['profile', 'preferences'].map(target => ({ op: 'remove_section', target, section: 's1' })),
      }],
    } };
  } } });
  try {
    forgetting.store.enqueue({ sessionId: 'forget', entryId: 'forget', text: 'Forget the synthetic background and preference.', source: 'interactive', scope: 'global', observedAt: user.observedAt });
    expect(await forgetting.run({ force: true })).toEqual({ outcome: 'committed' });
    const replay = new SessionIngress(forgetting.store);
    replay.capture(key, user);
    replay.capture(key, assistant);
    expect(forgetting.store.db.prepare('SELECT text FROM observations WHERE id=?').get(sourceId)!.text).toBeNull();
    expect(forgetting.store.db.prepare("SELECT text,unavailable FROM session_messages WHERE role='assistant'").get())
      .toEqual({ text: null, unavailable: 'source_unavailable' });
    expect(forgetting.store.sources(sourceKey('profile', 'Background'))).toEqual([]);
    expect(forgetting.store.sources(sourceKey('preferences', 'Style'))).toEqual([]);
    expect(readAuthorizedMemory({ dataRoot: root, contexts: ['global'] }).empty).toBe(true);
  } finally { forgetting.close(); }
});
