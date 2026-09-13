import type { MemoryAgentRuntime, MemoryReadPort, MemoryTask, StructuralBlock } from '../core/contracts/memory-agent.js';
import { maintenanceSchema, validateDecision } from './contract.js';
/** Synthetic Core contract, no SQLite or canonical files are opened. */
export async function probeMemoryAgent(agent: MemoryAgentRuntime, signal: AbortSignal): Promise<boolean> {
  let inspected = false, read = false;
  const text = 'Synthetic connection check. No user facts or durable memory changes.';
  const task: MemoryTask = { version: 'memory_task_v1', request_id: 'network-test', now: new Date().toISOString(),
    bundles: [{ ingest_id: 'probe', source: 'interactive', provenance: 'user_explicit', scope: 'global', block_count: 1, bytes: Buffer.byteLength(text), state: 'pending' }],
    snapshot: { handle: 'probe-memory', document_count: 0 }, decision_schema: maintenanceSchema };
  const descriptor: StructuralBlock = { block_id: 'probe-text', parent_id: null, kind: 'paragraph', order: 0, bytes: Buffer.byteLength(text), evidence_ref: 'ev_1', context_only: false, metadata: {source:'interactive',provenance:'user_explicit',scope:'global'} };
  const reads: MemoryReadPort = {
    manifest(handle) { if (handle !== 'probe') throw new Error('INVALID_INGEST_HANDLE'); inspected = true; return { blocks: [structuredClone(descriptor)], next: null }; },
    read(handle, block) { if (!inspected || handle !== 'probe' || block !== 'probe-text') throw new Error('INVALID_BLOCK_REFERENCE'); read = true; return { block_id: block, content: text, bytes: Buffer.byteLength(text), offset: 0, next: null, descriptor: structuredClone(descriptor) }; },
    memory(handle) { if (handle !== 'probe-memory') throw new Error('INVALID_SNAPSHOT_HANDLE'); return []; },
    processing() { return { complete: read, read_bytes: read ? Buffer.byteLength(text) : 0, total_bytes: Buffer.byteLength(text) }; },
  };
  const controller = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
  const result = await agent.decide(task, reads, { signal: controller, deadlineAt: Date.now() + 60000 });
  const decision = validateDecision(result.body, task.request_id, [], new Map([['ev_1', 'global']]));
  return inspected && read && decision.decisions.every(d => d.kind === 'ignore');
}
