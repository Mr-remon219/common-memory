import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SessionIngress, type SessionTurnState } from '../../src/v2/session.js';
import { Writer } from '../../src/v2/writer.js';
import type { ApprovedModelRequest } from '../../src/memory-manager/contracts/model-port.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.each<SessionTurnState>(['settled', 'interrupted', 'incomplete'])('keeps %s session completion honest across dead-letter, explicit retry and restart', async terminal => {
  const root = mkdtempSync(join(tmpdir(), 'cm-session-lifecycle-'));
  roots.push(root);
  const identity = { client: 'pi' as const, processInstance: 'synthetic', sessionId: 'session' };
  const message = { id: 'user', turnId: 'turn', role: 'user' as const, text: 'Synthetic delivered expression.', source: 'interactive', scope: 'global', observedAt: '2026-09-09T00:00:00Z' };
  const options = { dataRoot: root, allowedScopes: ['global'], scheduler: { maxAttempts: 1 } };
  let key: string, deadJob: string;
  const failed = new Writer({ ...options, model: { async analyze() { throw new Error('Synthetic provider failure'); } } });
  try {
    const ingress = new SessionIngress(failed.store);
    key = ingress.open(identity);
    ingress.capture(key, message);
    if (terminal !== 'incomplete') ingress.settle(key, 'turn', terminal);
    expect(ingress.status(key)).toEqual({ closing: false, complete: false, pending: 1, failed: 0, batches: 0 });
    ingress.end(key); // An open turn becomes incomplete; it is not a successful settlement.
    expect((await failed.run()).outcome).toBe('failed');
    deadJob = failed.store.status().jobs[0]!.id;
    expect(failed.store.status().jobs[0]!.state).toBe('dead');
    expect(ingress.status(key)).toEqual({ closing: true, complete: false, pending: 0, failed: 1, batches: 1 });
  } finally { failed.close(); }

  const requests: ApprovedModelRequest[] = [];
  const model = { async analyze(request: ApprovedModelRequest) {
    requests.push(request);
    return { kind: 'output' as const, usage: {}, body: {
      version: 'memory_maintenance_v2', request_id: request.projection.request_id,
      decisions: [{ kind: 'ignore', applicability: 'uncertain', confidence: 1, evidence: [], reason: 'Synthetic no retention' }],
    } };
  } };
  const retried = new Writer({ ...options, model });
  try {
    const ingress = new SessionIngress(retried.store);
    expect(ingress.open(identity)).toBe(key);
    expect(await retried.run({ force: true })).toEqual({ outcome: 'idle' });
    expect(requests).toHaveLength(0);
    expect(ingress.status(key).complete).toBe(false); // Idle is not complete.
    expect(retried.store.db.prepare('SELECT text FROM observations').get()!.text).toBe(message.text);
    retried.store.retry(deadJob);
    expect(ingress.status(key)).toMatchObject({ pending: 1, failed: 0, complete: false });
    expect(await retried.run()).toEqual({ outcome: 'ignored' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.projection.observations).toEqual([expect.objectContaining({ text: message.text, source_kind: 'user_turn' })]);
    expect(ingress.status(key).complete).toBe(terminal !== 'incomplete');
  } finally { retried.close(); }

  const restarted = new Writer({ ...options, model });
  try {
    const ingress = new SessionIngress(restarted.store);
    ingress.capture(key, message);
    ingress.end(key);
    expect(await restarted.run()).toEqual({ outcome: 'idle' });
    expect(requests).toHaveLength(1);
    expect(ingress.status(key)).toEqual({ closing: true, complete: terminal !== 'incomplete', pending: 0, failed: 0, batches: 1 });
    expect(restarted.store.db.prepare('SELECT COUNT(*) AS n FROM observations').get()!.n).toBe(1);
    expect(restarted.store.db.prepare('SELECT COUNT(*) AS n FROM receipts').get()!.n).toBe(1);
  } finally { restarted.close(); }
});
