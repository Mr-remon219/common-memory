import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CanonicalStore, type DocumentSnapshot } from './canonical.js';
import { RuntimeStore, type RuntimeJob, type RuntimeOptions, type RuntimeReceipt } from './runtime.js';
import { ProjectRegistry } from './registry.js';
import { withRepositoryLock } from './lock.js';
import { failureCode } from './errors.js';
import { maintenanceSchema, validateDecision, type Decision } from './contract.js';
import { externalPreflight } from '../core/safety/external-preflight.js';
import type { ApprovedModelRequest, MemoryModelPort } from '../memory-manager/contracts/model-port.js';

export const maintainerPrompt = readFileSync(new URL('./memory-maintainer.md', import.meta.url), 'utf8');
export interface WriterOptions {
  dataRoot: string; model: MemoryModelPort; allowedScopes: readonly string[]; writableScopes?: readonly string[];
  documentSoftBytes?: number; documentHardBytes?: number; retentionMs?: number;
  scheduler?: RuntimeOptions; deadlineMs?: number; maxRequestBytes?: number; modelVersion?: string;
  checkpoint?: (phase: 'files_committed') => void;
}
/** Network runs outside both locks. Canonical commits are fenced inside lock -> DB. */
export class Writer {
  readonly store: RuntimeStore;
  readonly canonical: CanonicalStore;
  readonly #options: WriterOptions;
  constructor(options: WriterOptions) {
    this.#options = { ...options, allowedScopes: [...options.allowedScopes], writableScopes: [...(options.writableScopes ?? options.allowedScopes)] };
    for (const n of [options.deadlineMs ?? 60000, options.maxRequestBytes ?? 131072, options.retentionMs ?? 604800000, options.documentSoftBytes ?? 8192]) if (!Number.isSafeInteger(n) || n <= 0) throw new Error('INVALID_WRITER_LIMIT');
    if ((options.documentSoftBytes ?? 8192) > (options.documentHardBytes ?? 16384)) throw new Error('INVALID_DOCUMENT_BUDGET');
    this.canonical = new CanonicalStore(options.dataRoot, {hardLimitBytes:options.documentHardBytes ?? 16384});
    this.store = new RuntimeStore(options.dataRoot, options.scheduler);
    try { this.recover(); this.store.pruneProcessed(this.#options.retentionMs); } catch (error) { this.store.close(); throw error; }
  }
  recover(): void {
    withRepositoryLock(this.#options.dataRoot, () => this.store.transaction(() => {
      this.canonical.recover();
      for (const receipt of this.canonical.receipts()) this.store.recoverReceipt(receipt as unknown as RuntimeReceipt);
    }));
  }
  async run(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<{outcome:string; reason?:string}> {
    this.store.pruneProcessed(this.#options.retentionMs);
    if (!this.store.hasWork()) return {outcome:'idle'};
    this.recover();
    const claimed = this.store.claim(options);
    if (!claimed) return { outcome: 'idle' };
    let job: RuntimeJob = claimed;
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(this.#options.deadlineMs ?? 60000);
    const signal = AbortSignal.any([controller.signal, deadline, ...(options.signal ? [options.signal] : [])]);
    const timer = setInterval(() => { try { this.store.renew(job!); } catch { controller.abort(); } }, Math.max(1, Math.floor((this.#options.scheduler?.leaseMs ?? 120000) / 3)));
    timer.unref();
    try {
      const scope = job.observations[0]!.scope;
      if (!this.#options.allowedScopes.includes(scope)) return this.#quarantine(job, 'UNAUTHORIZED_SOURCE');
      const registered = new ProjectRegistry(this.#options.dataRoot).list();
      if (scope !== 'global' && !registered.some(p => `project:${p.id}` === scope)) return this.#quarantine(job, 'UNREGISTERED_PROJECT');
      const documents = withRepositoryLock(this.#options.dataRoot, () => this.canonical.snapshot(scope === 'global' ? [] : [scope.slice(8)]))
        .filter(doc => this.#options.allowedScopes.includes(documentScope(doc)));
      const cap = this.#options.maxRequestBytes ?? 131072;
      for (const observation of job.observations) {
        try { externalPreflight({text:observation.text}, {maxExcerptBytes:cap,maxCandidateBytes:cap,maxTotalBytes:Number.MAX_SAFE_INTEGER}); }
        catch { this.store.quarantine(job, observation.id, 'SENSITIVE_INPUT'); return {outcome:'quarantined'}; }
      }
      let context = this.store.context(job.observations[0]!);
      let request = this.#request(job, documents, context);
      while (this.#bytes(request) > cap && context.length) {
        context = context.slice(1); request = this.#request(job, documents, context);
      }
      while (this.#bytes(request) > cap && job.observations.length > 1) {
        job = this.store.trim(job, job.observations.length - 1);
        request = this.#request(job, documents, context);
      }
      if (this.#bytes(request) > cap) return this.#quarantine(job, 'OVERSIZED_COMPLETE_TURN');
      externalPreflight(request.projection, {maxExcerptBytes:cap,maxCandidateBytes:cap,maxTotalBytes:cap});
      signal.throwIfAborted();
      const result = await abortable(this.#options.model.analyze(request, {requestId:job.id,deadlineMs:this.#options.deadlineMs ?? 60000,signal}), signal);
      signal.throwIfAborted();
      if (result.kind === 'refusal') throw new Error('MODEL_REFUSAL');
      const evidence = new Map(job.observations.map(o => [`ev_${o.id}`,o.scope]));
      const decision = validateDecision(result.body, job.id, documents, evidence);
      const operations = decision.decisions.flatMap(d => d.kind === 'ignore' ? [] : d.operations);
      for (const op of operations) if (scope !== 'global' && op.target !== scope) throw new Error('UNAUTHORIZED_SCOPE');
      for (const op of operations) if (!this.#options.writableScopes!.includes(op.target.startsWith('project:') ? op.target : 'global')) throw new Error('UNAUTHORIZED_WRITE');
      const updates = this.canonical.apply(documents, operations);
      externalPreflight(Object.fromEntries(updates), {maxExcerptBytes:cap,maxCandidateBytes:cap,maxTotalBytes:cap});
      withRepositoryLock(this.#options.dataRoot, () => this.store.transaction(() => {
        signal.throwIfAborted(); this.store.assertLease(job);
        if (scope !== 'global' && !new ProjectRegistry(this.#options.dataRoot).list().some(p => `project:${p.id}` === scope)) throw new Error('UNAUTHORIZED_SCOPE');
        // Even ignore is tied to the complete snapshot, never consume a stale analysis.
        const current = this.canonical.snapshot(scope === 'global' ? [] : [scope.slice(8)]);
        if (documents.some(doc => current.find(d => d.target === doc.target)?.hash !== doc.hash)) throw new Error('STALE_REVISION');
        const receipt = this.#receipt(job, documents, decision.decisions, updates);
        if (!operations.length) { this.store.finish(job, receipt); return; }
        this.canonical.commit(documents, updates, { ...receipt, id:job.id, version:2, decisions:decision.decisions.map(d => d.kind),
          promptDigest:digest(maintainerPrompt), modelVersion:this.#options.modelVersion ?? 'configured-model', timestamp:new Date().toISOString(), usage:result.usage,
          sources:job.observations.map(o => ({id:o.id,sessionId:o.sessionId,entryId:o.entryId,digest:digest(o.text ?? '')})),
          documents:documents.map(doc => ({target:doc.target,before:doc.hash,after:updates.has(doc.target) ? digest(updates.get(doc.target)!) : doc.hash})),
        }, () => { signal.throwIfAborted(); this.store.assertLease(job); });
        this.#options.checkpoint?.('files_committed');
        this.store.finish(job, receipt);
      }));
      return { outcome: operations.length ? 'committed' : 'ignored' };
    } catch (error) {
      // A durable receipt wins over transient DB failure; startup reconciles without another model call.
      try { this.recover(); } catch {
        try { this.store.fail(job, new Error('RECOVERY_CONFLICT')); } catch { /* Lease may already be fenced. */ }
        return {outcome:'failed',reason:'RECOVERY_CONFLICT'};
      }
      if (this.store.status().jobs.some(row => row.id === job.id && row.state === 'done')) return {outcome:'committed'};
      try { this.store.fail(job, error); } catch { /* A recovered receipt or superseded lease owns this batch. */ }
      return {outcome:signal.aborted ? 'cancelled' : 'failed',reason:signal.aborted ? 'CANCELLED' : failureCode(error)};
    } finally { clearInterval(timer); }
  }
  #quarantine(job: RuntimeJob, issue: string): {outcome:string} { this.store.quarantine(job, job.observations[0]!.id, issue); return {outcome:'quarantined'}; }
  #request(job: RuntimeJob, documents: DocumentSnapshot[], context: RuntimeJob['observations'] = []): ApprovedModelRequest {
    return {prompt:maintainerPrompt,schema:maintenanceSchema,schemaName:'memory_maintenance_v2',projection:{
      version:'memory_maintenance_v2',request_id:job.id,now:new Date().toISOString(),
      observations:job.observations.map(o => ({ref:`ev_${o.id}`,text:o.text,scope:o.scope,observed_at:o.observedAt,context_only:false})),
      documents:documents.map(doc => ({target:doc.target,hash:doc.hash,content:doc.content,sections:doc.sections,soft_budget_bytes:this.#options.documentSoftBytes ?? 8192,hard_budget_bytes:this.canonical.hardLimitBytes,writable:this.#options.writableScopes!.includes(documentScope(doc))})),
      context_only:context.map(o => ({text:o.text,observed_at:o.observedAt,scope:o.scope,context_only:true})),
    }};
  }
  #bytes(request: ApprovedModelRequest): number { return this.#options.model.serializedRequestBytes?.(request) ?? Buffer.byteLength(JSON.stringify(request)); }
  #receipt(job: RuntimeJob, documents: DocumentSnapshot[], decisions: Decision[], updates: Map<string,string>): RuntimeReceipt & { removeTargets:string[] } {
    const associations: {target:string;sourceIds:number[]}[] = [], removeTargets:string[] = [], forget = new Set<number>();
    // Manual Markdown edits invalidate title-based sidecar identities. Keep current
    // Markdown, but conservatively purge this document's short-lived source bodies
    // and stale links in the same recoverable receipt, never guess a rename.
    const externallyEdited = new Set<string>();
    for (const doc of documents) {
      const prior = this.store.documentVersion(doc.target);
      if (prior !== null && prior !== doc.hash) {
        externallyEdited.add(doc.target);
        for (const key of this.store.documentSourceKeys(doc.target)) {
          removeTargets.push(key); for (const id of this.store.sources(key)) forget.add(id);
        }
      }
    }
    for (const d of decisions) {
      if (d.kind === 'ignore') continue;
      const removedSources = new Set<number>();
      const priorSources = new Map<string, number[]>();
      for (const op of d.operations) {
        const title = documents.find(doc => doc.target === op.target)?.sections.find(s => s.ref === op.section)?.title;
        if (title !== undefined) {
          const key = `${op.target}:${digest(title)}`; removeTargets.push(key);
          const sources = externallyEdited.has(op.target) ? [] : this.store.sources(key); priorSources.set(`${op.target}:${op.section}`, sources);
          for (const id of sources) { if (op.op === 'remove_section') removedSources.add(id); if (d.kind === 'forget') forget.add(id); }
        }
      }
      if (d.kind === 'forget') for (const ref of d.evidence) forget.add(Number(ref.slice(3)));
      for (const op of d.operations) if (op.op === 'put_section') {
        // Replacements inherit themselves, never other replaced sections. Explicit
        // removals in this decision supply move/merge sources to the destination.
        const inherited = [...(priorSources.get(`${op.target}:${op.section}`) ?? []), ...removedSources];
        associations.push({target:`${op.target}:${digest(op.title!)}`,sourceIds:[...new Set([...inherited,...d.evidence.map(ref => Number(ref.slice(3)))])]});
      }
    }

    return {documents:documents.map(doc => ({target:doc.target,after:updates.has(doc.target)?digest(updates.get(doc.target)!):doc.hash})),jobId:job.id,observationIds:job.observations.map(o => o.id),associations,removeTargets,forgetSourceIds:[...forget]};
  }
  close(): void { this.store.close(); }
}
function documentScope(doc: DocumentSnapshot): string { return doc.target.startsWith('project:') ? doc.target : 'global'; }
function digest(value:string):string { return createHash('sha256').update(value).digest('hex'); }
function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T> {
  return new Promise((resolve,reject) => { const abort = () => reject(new Error('CANCELLED')); signal.addEventListener('abort',abort,{once:true}); if(signal.aborted) abort(); promise.then(resolve,reject).finally(() => signal.removeEventListener('abort',abort)); });
}
