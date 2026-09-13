import { randomUUID, createHash } from 'node:crypto';
import type { MemoryTask, MemoryReadPort, StructuralBlock, ContentPage, BundleSummary } from '../core/contracts/memory-agent.js';
import { externalPreflight } from '../core/safety/external-preflight.js';
import type { RuntimeStore, RuntimeJob } from './runtime.js';
import type { DocumentSnapshot } from './canonical.js';
import { maintenanceSchema, type Decision } from './contract.js';
import { ingestSummary, material, type BlockRange } from './ingest.js';
import { provenanceOf } from './import.js';
import { sessionProjection } from './session.js';

const PAGE_BYTES = 8192;
const SCAN_CAPS = { maxExcerptBytes: Number.MAX_SAFE_INTEGER, maxCandidateBytes: Number.MAX_SAFE_INTEGER, maxTotalBytes: Number.MAX_SAFE_INTEGER };
interface ReadBlock { descriptor: StructuralBlock; text: string; required: boolean; covered: number }
/** Every returned byte belongs to this attempt's authorized immutable read set. */
export function openMemoryTask(store: RuntimeStore, job: RuntimeJob, documents: DocumentSnapshot[], options: {
  signal: AbortSignal; contextAuthorized: boolean; contextTail: number; writableScopes: readonly string[]; softBytes: number; hardBytes: number;
}) {
  const blocks = new Map<string, ReadBlock[]>();
  let summaries: BundleSummary[] = job.observations.map(o => ingestSummary(store, o));
  const snapshotHandle = randomUUID();
  const inspected = new Set<string>();
  const memoryCoverage = new Map<string, number>();
  let active = true;
  const check = () => { options.signal.throwIfAborted(); if (!active) throw new Error('EXPIRED_TASK'); store.assertLease(job); };
  const add = (handle: string, ranges: BlockRange[], fields: Record<string, string>, metadata: Record<string, unknown>, evidence: string | undefined, required: boolean) => {
    const list = blocks.get(handle) ?? [];
    for (const range of ranges) {
      const text = fields[range.field]!.slice(range.start, range.end);
      const descriptor: StructuralBlock = { block_id: range.id, parent_id: range.parent, kind: range.kind, order: list.length, bytes: Buffer.byteLength(text),
        context_only: evidence === undefined, ...(evidence ? { evidence_ref: evidence } : {}), metadata,
        ...(range.kind === 'section' ? { label: [...text.trim()].slice(0, 128).join('') } : {}) };
      list.push({ descriptor, text, required, covered: 0 });
    }
    blocks.set(handle, list);
  };
  for (const observation of job.observations) {
    const handle = `ingest_${observation.id}`;
    const value = material(observation.source, observation.text);
    const ranges = store.db.prepare('SELECT * FROM ingest_blocks WHERE bundleId=? ORDER BY ordinal').all(handle) as unknown as BlockRange[];
    add(handle, ranges, { text: value.text, gaps: value.gaps ?? '' }, { ...value.metadata, source: observation.source, ...(provenanceOf(observation.source)==='user_explicit'?{role:'user'}:{}), provenance: provenanceOf(observation.source), scope: observation.scope, observed_at: observation.observedAt }, `ev_${observation.id}`, true);
  }
  // Already-persisted v1 imports keep receipt/job identities. This parent explicitly covers
  // only the claimed legacy subset, never purged/processed parts outside the attempt.
  const legacyGroups = new Map<string, typeof job.observations>();
  for (const observation of job.observations) {
    if (observation.source !== 'document_import') continue;
    const part = material(observation.source, observation.text).metadata.part as {count:number} | undefined;
    if (!part || part.count <= 1) continue;
    legacyGroups.set(observation.sessionId, [...(legacyGroups.get(observation.sessionId) ?? []), observation]);
  }
  for (const [session, observations] of legacyGroups) {
    const handle = 'legacy_' + createHash('sha256').update(session).digest('hex');
    const combined: ReadBlock[] = [];
    let originalCount = 0;
    for (const observation of observations) {
      const oldHandle = `ingest_${observation.id}`, prefix = `part_${observation.id}_`;
      const value = material(observation.source, observation.text);
      originalCount = Math.max(originalCount, (value.metadata.part as {count:number}).count);
      const parent = prefix + 'root';
      combined.push({ descriptor: {block_id:parent,parent_id:null,kind:'document_part',order:combined.length,bytes:0,context_only:true,metadata:{...value.metadata,legacy_subset:true}},text:'',required:false,covered:0 });
      for (const block of blocks.get(oldHandle) ?? []) combined.push({...block,descriptor:{...block.descriptor,block_id:prefix+block.descriptor.block_id,parent_id:block.descriptor.parent_id ? prefix+block.descriptor.parent_id : parent,order:combined.length}});
      blocks.delete(oldHandle);
      summaries = summaries.filter(summary => summary.ingest_id !== oldHandle);
    }
    blocks.set(handle,combined);
    summaries.push({ingest_id:handle,source:'document_import',provenance:'document_import',scope:observations[0]!.scope,block_count:combined.length,bytes:combined.reduce((n,b)=>n+b.descriptor.bytes,0),state:'claimed',legacy_subset:true,original_part_count:originalCount});
  }
  // Conversation structure is preserved even when its contextual bodies are unavailable by policy.
  const turns = sessionProjection(store, job, options.contextAuthorized, options.contextTail) as {
    turn_id: string; state: string; context_only: boolean; messages: Record<string, unknown>[];
  }[];
  const addContextSummary = (handle: string, state: string) => {
    const list = blocks.get(handle)!;
    summaries.push({ingest_id:handle,source:'conversation_context',provenance:'conversation_context',scope:job.observations[0]!.scope,block_count:list.length,bytes:list.reduce((n,b)=>n+b.descriptor.bytes,0),state});
  };
  for (const turn of turns) for (const message of turn.messages) {
    if (typeof message.ref === 'string') {
      for (const list of blocks.values()) for (const b of list) if (b.descriptor.evidence_ref === message.ref) {
        b.descriptor.metadata = { ...b.descriptor.metadata, turn_id: turn.turn_id, turn_state: turn.state, message_id: message.message_id, message_order: message.message_order, role: message.role };
      }
      continue;
    }
    const { text, ingest_id, ...metadata } = message;
    const handle = String(ingest_id), content = typeof text === 'string' ? text : '';
    const table = message.role === 'user' ? 'ingest_blocks' : 'session_ingest_blocks';
    // Never expose unauthorized labels or structure from the persistent owner.
    const ranges = typeof text === 'string' && !message.unavailable
      ? store.db.prepare(`SELECT * FROM ${table} WHERE bundleId=? ORDER BY ordinal`).all(handle) as unknown as BlockRange[]
      : [{id:'conversation',parent:null,kind:'conversation',start:0,end:0,field:'text'}];
    add(handle, ranges, {text:content}, {...metadata,scope:message.source_scope,provenance:'conversation_context',turn_id:turn.turn_id,turn_state:turn.state,previous_turn:turn.context_only}, undefined, !turn.context_only);
    addContextSummary(handle, typeof text === 'string' && !message.unavailable ? 'context_only' : 'unavailable');
  }
  if (!turns.length && options.contextAuthorized && options.contextTail > 0) for (const observation of store.context(job.observations[0]!)) {
    const handle = `ingest_${observation.id}`, value = material(observation.source, observation.text);
    const ranges = store.db.prepare('SELECT * FROM ingest_blocks WHERE bundleId=? ORDER BY ordinal').all(handle) as unknown as BlockRange[];
    add(handle,ranges,{text:value.text,gaps:value.gaps??''},{...value.metadata,...(provenanceOf(observation.source)==='user_explicit'?{role:'user'}:{}),scope:observation.scope,provenance:'conversation_context',previous_turn:true},undefined,false);
    addContextSummary(handle,observation.text === null ? 'unavailable' : 'context_only');
  }
  // Scan complete materials and metadata before any model invocation, including qualifiers and gaps.
  for (const list of blocks.values()) for (const b of list) externalPreflight({ descriptor: b.descriptor, text: b.text }, SCAN_CAPS);
  for (const doc of documents) externalPreflight({ content: doc.content }, SCAN_CAPS);
  const task: MemoryTask = { version: 'memory_task_v1', request_id: job.id, now: new Date().toISOString(), bundles: summaries, snapshot: { handle: snapshotHandle, document_count: documents.length }, decision_schema: structuredClone(maintenanceSchema) };
  const reads: MemoryReadPort = {
    manifest(handle, offset = 0) {
      check(); const list = blocks.get(handle); if (!list) throw new Error('INVALID_INGEST_HANDLE'); validateOffset(offset, list.length);
      return { blocks: list.slice(offset, offset + 32).map(b => structuredClone(b.descriptor)), next: offset + 32 < list.length ? offset + 32 : null };
    },
    read(handle, id, offset = 0) {
      check(); const b = blocks.get(handle)?.find(b => b.descriptor.block_id === id); if (!b) throw new Error('INVALID_BLOCK_REFERENCE');
      if (offset > b.covered) throw new Error('NONCONTIGUOUS_READ');
      const page = contentPage(id, b.text, offset); b.covered = Math.max(b.covered, page.next ?? page.bytes);
      return { ...page, descriptor: structuredClone(b.descriptor) };
    },
    memory(handle, target, offset = 0) {
      check(); if (handle !== snapshotHandle) throw new Error('INVALID_SNAPSHOT_HANDLE');
      if (target === undefined) return documents.map(d => ({ target: d.target, hash: d.hash, bytes: Buffer.byteLength(d.content), sections: d.sections.map(s => ({ ref: s.ref, title: s.title })),
        writable: options.writableScopes.includes(d.target.startsWith('project:') ? d.target : 'global'), soft_budget_bytes: options.softBytes, hard_budget_bytes: options.hardBytes }));
      const doc = documents.find(d => d.target === target); if (!doc) throw new Error('INVALID_TARGET_REFERENCE');
      if (offset > (memoryCoverage.get(target) ?? 0)) throw new Error('NONCONTIGUOUS_READ');
      const page = contentPage(target, doc.content, offset); memoryCoverage.set(target, Math.max(memoryCoverage.get(target) ?? 0, page.next ?? page.bytes));
      if (page.next === null) inspected.add(target);
      return page;
    },
    processing() {
      check(); const required = [...blocks.values()].flat().filter(b => b.required);
      return { complete: required.every(b => b.covered === b.descriptor.bytes), read_bytes: required.reduce((n, b) => n + b.covered, 0), total_bytes: required.reduce((n, b) => n + b.descriptor.bytes, 0) };
    },
  };
  return { task, reads, close() { active = false; }, assertCoverage(decisions: Decision[]) {
    check(); if (!reads.processing().complete) throw new Error('INCOMPLETE_INGEST_COVERAGE');
    for (const decision of decisions) if (decision.kind !== 'ignore') for (const operation of decision.operations) if (!inspected.has(operation.target)) throw new Error('UNREAD_MEMORY_TARGET');
  } };
}
function validateOffset(offset: number, size: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) throw new Error('INVALID_PAGE_OFFSET');
}
function contentPage(id: string, text: string, offset: number): ContentPage {
  const bytes = Buffer.from(text); validateOffset(offset, bytes.length);
  if (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) throw new Error('INVALID_PAGE_OFFSET');
  let end = Math.min(bytes.length, offset + PAGE_BYTES);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return { block_id: id, content: bytes.subarray(offset, end).toString('utf8'), offset, next: end < bytes.length ? end : null, bytes: bytes.length };
}
