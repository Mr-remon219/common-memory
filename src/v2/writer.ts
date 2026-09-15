import { sanitizeModelUsage } from '../core/contracts/model-output.js';
import { sessionGroup, type SessionCacheOptions } from './session.js';
import { createHash } from 'node:crypto';
import { CanonicalStore, type DocumentSnapshot } from './canonical.js';
import { RuntimeStore, type RuntimeJob, type RuntimeOptions, type RuntimeReceipt } from './runtime.js';
import { ProjectRegistry } from './registry.js';
import { withRepositoryLock } from './lock.js';
import { sanitizeDiagnostic, type FailureDiagnostic, type DiagnosticStage } from '../core/contracts/diagnostic.js';
import { failureDiagnostic, failureCode } from './errors.js';
import { validateDecision, type Decision } from './contract.js';
import { externalPreflight, serializedSourceBytes } from '../core/safety/external-preflight.js';
import { isImportSource, provenanceOf, type ProvenanceKind } from './import.js';
import type { MemoryAgentRuntime } from '../core/contracts/memory-agent.js';
import { openMemoryTask } from './memory-task.js';
import { setTimeout as delay } from 'node:timers/promises';

export interface WriterOptions {
  dataRoot: string; agent: MemoryAgentRuntime; allowedScopes: readonly string[]; writableScopes?: readonly string[];
  /** Provenance classes that may be sent to the remote model; a batch outside it is quarantined, never disclosed. Omitted means all. */
  allowedProvenance?: readonly ProvenanceKind[];
  documentSoftBytes?: number; documentHardBytes?: number; retentionMs?: number;
  sessionCache?: SessionCacheOptions; scheduler?: RuntimeOptions; /** @deprecated Ignored: no whole-task deadline. */ deadlineMs?: number;
  configurationVersion?: string; maxAgentTurns?: number; maxRequestBytes?: number; maxSourceBytes?: number | undefined; modelVersion?: string;
  checkpoint?: (phase: 'files_committed') => void;
}
/** Network runs outside both locks. Canonical commits are fenced inside lock -> DB. */
export class Writer {
  readonly store: RuntimeStore;
  readonly canonical: CanonicalStore;
  readonly #options: WriterOptions;
  constructor(options: WriterOptions) {
    this.#options = { ...options, allowedScopes: [...options.allowedScopes], writableScopes: [...(options.writableScopes ?? options.allowedScopes)] };
    for (const n of [ options.maxRequestBytes ?? Number.MAX_SAFE_INTEGER, options.maxSourceBytes ?? Number.MAX_SAFE_INTEGER, options.retentionMs ?? 604800000, options.documentSoftBytes ?? 8192]) if (!Number.isSafeInteger(n) || n <= 0) throw new Error('INVALID_WRITER_LIMIT');
    if ((options.documentSoftBytes ?? 8192) > (options.documentHardBytes ?? 16384)) throw new Error('INVALID_DOCUMENT_BUDGET');
    this.canonical = new CanonicalStore(options.dataRoot, {hardLimitBytes:options.documentHardBytes ?? 16384});
    this.store = new RuntimeStore(options.dataRoot, options.scheduler);
    try { this.recover(); this.store.pruneProcessed(this.#options.retentionMs); } catch (error) { this.store.close(); throw error; }
  }
  /** Composition may refresh settings only between tasks; each run retains its own snapshot. */
  protected configure(options: { [K in keyof Omit<WriterOptions, 'dataRoot'>]?: WriterOptions[K] | undefined }): void { Object.assign(this.#options, options); }
  recover(): void { this.#recover(); }
  #recover(jobId?: string): 'committed' | 'ignored' | null {
    return withRepositoryLock(this.#options.dataRoot, () => this.store.transaction(() => {
      this.canonical.recover();
      const receipts = this.canonical.receipts();
      for (const receipt of receipts) this.store.recoverReceipt(receipt as unknown as RuntimeReceipt);
      if (!jobId || !this.store.hasReceipt(jobId)) return null;
      // File commits have immutable canonical receipts; ignore commits have a durable DB receipt only.
      // Another lease may have made a different decision from this run's late response.
      return receipts.some(receipt => receipt.id === jobId) ? 'committed' : 'ignored';
    }));
  }
  async run(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<{outcome:string; reason?:string}> {
    const settings = { ...this.#options };
    this.store.pruneProcessed(settings.retentionMs);
    if (!this.store.hasWork()) return {outcome:'idle'};
    this.recover();
    const claimed = this.store.claim({...options,globalWrites:settings.writableScopes!.includes('global')});
    if (!claimed) return { outcome: 'idle' };
    let job: RuntimeJob = claimed;
    this.store.configureTask(job, settings.configurationVersion);
    const controller = new AbortController();
    // First terminal cause wins, even if the model rejects with its own generic cancellation later.
    const terminate = (reason: 'TIMEOUT' | 'CANCELLED' | 'LEASE_RENEWAL_FAILED' | 'SERVICE_HANDOFF') => { if (!controller.signal.aborted) controller.abort(new Error(reason)); };
    const cancelled = () => terminate(options.signal?.reason instanceof Error && options.signal.reason.message==='SERVICE_HANDOFF' ? 'SERVICE_HANDOFF' : 'CANCELLED');
    options.signal?.addEventListener('abort', cancelled, {once:true});
    if (options.signal?.aborted) cancelled();
    // No total-task timer. The transport detects stalled individual operations;
    // caller cancellation and lease loss still fence every read and commit.
    const signal = controller.signal;
    let stage: DiagnosticStage = 'core_validation';
    let remoteContext: FailureDiagnostic | null = null;
    const timer = setInterval(() => { try { this.store.renew(job!); } catch { terminate('LEASE_RENEWAL_FAILED'); } }, Math.max(1, Math.floor((this.#options.scheduler?.leaseMs ?? 120000) / 3)));
    timer.unref();
    try {
      signal.throwIfAborted();
      const scope = job.observations[0]!.scope;
      if (this.store.isForgotten(job)) return this.#quarantine(job,'FORGOTTEN_SOURCE');
      if (!this.#options.allowedScopes.includes(scope)) return this.#quarantine(job, 'UNAUTHORIZED_SOURCE');
      // Disclosure authorization is per provenance class, not per process: an init-only configuration
      // processes imports while any user turn that reaches this queue stays local.
      const provenance = provenanceOf(job.observations[0]!.source);
      if (this.#options.allowedProvenance && (!provenance || !this.#options.allowedProvenance.includes(provenance))) return this.#quarantine(job, 'UNAUTHORIZED_PROVENANCE');
      const registered = new ProjectRegistry(this.#options.dataRoot).list();
      if (scope !== 'global' && !registered.some(p => `project:${p.id}` === scope)) return this.#quarantine(job, 'UNREGISTERED_PROJECT');
      const documents = withRepositoryLock(this.#options.dataRoot, () => this.canonical.snapshot(scope === 'global' ? [] : [scope.slice(8)]))
        .filter(doc => this.#options.allowedScopes.includes(documentScope(doc)));
      const cap = this.#options.maxRequestBytes ?? Number.MAX_SAFE_INTEGER;
      for (const observation of job.observations) {
        try { externalPreflight({text:observation.text}, {}); }
        catch { this.store.quarantine(job, observation.id, 'SENSITIVE_INPUT'); return {outcome:'quarantined'}; }
      }
      const sourceCap = this.#options.maxSourceBytes ?? Number.MAX_SAFE_INTEGER;
      for (const observation of job.observations) {
        if (serializedSourceBytes(observation.text) > sourceCap) { this.store.quarantine(job, observation.id, 'OVERSIZED_COMPLETE_SOURCE'); return {outcome:'quarantined'}; }
      }
      let contextTail = this.#options.sessionCache?.contextTailTurns ?? 2;
      const open = () => openMemoryTask(this.store, job, documents, {
        signal, contextAuthorized: this.#options.allowedProvenance?.includes('conversation_context') === true,
        contextTail, writableScopes: job.observations[0]!.taskKind === 'edit' ? this.#options.writableScopes!.filter(s => s === scope) : this.#options.writableScopes!,
        maxSourceBytes:sourceCap, softBytes: this.#options.documentSoftBytes ?? 8192, hardBytes: this.canonical.hardLimitBytes,
      });
      let grant = open();
      const sourceBytes = () => grant.sourceBytes;
      let result;
      let promptDigest: string;
      try {
        // Optional previous context yields first. Never drop current qualifiers or split a turn.
        if ((sourceBytes() > cap || grant.oversizedContext()) && contextTail > 0) { grant.close(); contextTail = 0; grant = open(); }
        while (sourceBytes() > cap && job.observations.length > 1) {
          const last = sessionGroup(this.store, job.observations.at(-1)!);
          const count = last ? job.observations.findIndex(o => sessionGroup(this.store, o)?.turn === last.turn) : job.observations.length - 1;
          if (count === 0) break;
          grant.close(); job = this.store.trim(job, count); grant = open();
        }
        const oversized = grant.oversizedContext();
        if (oversized?.observationId != null) { this.store.quarantine(job, oversized.observationId, 'OVERSIZED_COMPLETE_SOURCE'); return {outcome:'quarantined'}; }
        if (sourceBytes() > cap) return this.#quarantine(job, 'OVERSIZED_COMPLETE_TURN');
        result = await abortable(settings.agent.decide(grant.task, grant.reads, {
          signal,
          ...(settings.configurationVersion ? {configurationVersion:settings.configurationVersion} : {}),
          onActivity: kind => this.store.activity(job,kind,settings.maxAgentTurns ?? 64),
          validateDecision: body => {
            const checked = validateDecision(body,job.id,documents,new Map(job.observations.map(o=>[`ev_${o.id}`,o.scope])),job.observations[0]!.taskKind);
            grant.assertCoverage(checked);
            this.#guardImports(job,checked.decisions,documents);
            for (const d of checked.decisions) if(d.kind!=='ignore') for(const op of d.operations)this.store.assertSourceCurrent(job,op.target,d.evidence);
            const operations = checked.decisions.flatMap(d=>d.kind==='ignore'?[]:d.operations);
            for (const op of operations) {
              const targetScope = op.target.startsWith('project:') ? op.target : 'global';
              if (targetScope !== scope && (op.target.startsWith('project:') || job.observations[0]!.taskKind === 'edit')) throw new Error('UNAUTHORIZED_SCOPE');
              if (!settings.writableScopes!.includes(targetScope)) throw new Error('UNAUTHORIZED_WRITE');
            }
            const updates = this.canonical.apply(documents,operations);
            if (checked.edit_result === 'modified' && !documents.some(doc=>updates.has(doc.target)&&updates.get(doc.target)!==doc.content)) throw new Error('INVALID_EDIT_RESULT');
            externalPreflight(Object.fromEntries(updates),{maxExcerptBytes:cap,maxCandidateBytes:cap,maxTotalBytes:cap});
          },
          recover: async error => {
            signal.throwIfAborted();
            const diagnostic = failureDiagnostic(error);
            const code = failureCode(error);
            if (!diagnostic.retryable || ['AUTHENTICATION','PROXY_AUTHENTICATION','CONFIGURATION','CANCELLED','SENSITIVE_CONTENT_REJECTED'].includes(code)) return false;
            const used = this.store.reserveRecovery(job);
            if (used === null) return false;
            if (['network','request','http','response_body'].includes(diagnostic.stage)) await delay(Math.min(30_000,1000*2**(used-1)),undefined,{signal});
            return true;
          },
          onDiagnosticContext: context => { remoteContext = sanitizeDiagnostic({...context,reason:'timeout',retryable:true}); },
        }), signal);
        signal.throwIfAborted();
        const suppliedDigest: unknown = result?.promptDigest;
        if (typeof suppliedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(suppliedDigest)) throw new Error('INVALID_PROMPT_DIGEST');
        promptDigest = suppliedDigest;
        const checked = validateDecision(result.body, job.id, documents, new Map(job.observations.map(o => [`ev_${o.id}`, o.scope])), job.observations[0]!.taskKind);
        grant.assertCoverage(checked);
      } finally { grant.close(); }
      const evidence = new Map(job.observations.map(o => [`ev_${o.id}`,o.scope]));
      const decision = validateDecision(result.body, job.id, documents, evidence, job.observations[0]!.taskKind);
      this.#guardImports(job, decision.decisions, documents);
      for(const d of decision.decisions)if(d.kind!=='ignore')for(const op of d.operations)this.store.assertSourceCurrent(job,op.target,d.evidence);
      const operations = decision.decisions.flatMap(d => d.kind === 'ignore' ? [] : d.operations);
      if (job.observations[0]!.taskKind === 'edit' && operations.some(op => (op.target.startsWith('project:') ? op.target : 'global') !== scope)) throw new Error('UNAUTHORIZED_WRITE');
      for (const op of operations) if (op.target.startsWith('project:') && op.target !== scope) throw new Error('UNAUTHORIZED_SCOPE');
      for (const op of operations) if (!this.#options.writableScopes!.includes(op.target.startsWith('project:') ? op.target : 'global')) throw new Error('UNAUTHORIZED_WRITE');
      const updates = this.canonical.apply(documents, operations);
      if (decision.edit_result === 'modified' && !documents.some(doc => updates.has(doc.target) && updates.get(doc.target) !== doc.content)) throw new Error('INVALID_EDIT_RESULT');
      externalPreflight(Object.fromEntries(updates), {maxExcerptBytes:cap,maxCandidateBytes:cap,maxTotalBytes:cap});
      stage = 'commit';
      withRepositoryLock(this.#options.dataRoot, () => this.store.transaction(() => {
        signal.throwIfAborted(); this.store.assertLease(job);
        if (this.store.isForgotten(job)) throw new Error('FORGOTTEN_SOURCE');
        for(const d of decision.decisions)if(d.kind!=='ignore')for(const op of d.operations)this.store.assertSourceCurrent(job,op.target,d.evidence);
        if (scope !== 'global' && !new ProjectRegistry(this.#options.dataRoot).list().some(p => `project:${p.id}` === scope)) throw new Error('UNAUTHORIZED_SCOPE');
        // Even ignore is tied to the complete snapshot, never consume a stale analysis.
        const current = this.canonical.snapshot(scope === 'global' ? [] : [scope.slice(8)]);
        if (documents.some(doc => current.find(d => d.target === doc.target)?.hash !== doc.hash)) throw new Error('STALE_REVISION');
        const receipt = { ...this.#receipt(job, documents, decision.decisions, updates), ...(decision.edit_result ? {editResult: decision.edit_result} : {}) };
        if (!operations.length) { this.store.finish(job, receipt); return; }
        this.canonical.commit(documents, updates, { ...receipt, id:job.id, version:2, decisions:decision.decisions.map(d => d.kind),
          promptDigest, modelVersion:this.#options.modelVersion ?? 'configured-model', timestamp:new Date().toISOString(), usage:sanitizeModelUsage(result.usage),
          sources:job.observations.map(o => ({id:o.id,sessionId:o.sessionId,entryId:o.entryId,digest:digest(o.text ?? '')})),
          documents:documents.map(doc => ({target:doc.target,before:doc.hash,after:updates.has(doc.target) ? digest(updates.get(doc.target)!) : doc.hash})),
        }, () => { signal.throwIfAborted(); this.store.assertLease(job); });
        this.#options.checkpoint?.('files_committed');
        this.store.finish(job, receipt);
      }));
      return { outcome: operations.length ? 'committed' : 'ignored' };
    } catch (error) {
      // A durable receipt wins over transient DB failure; startup reconciles without another model call.
      let recovered: 'committed' | 'ignored' | null;
      try { recovered = this.#recover(job.id); } catch {
        try { this.store.fail(job, new Error('RECOVERY_CONFLICT')); } catch { /* Lease may already be fenced. */ }
        return {outcome:'failed',reason:'RECOVERY_CONFLICT'};
      }
      if (recovered) return {outcome:recovered};
      const cause: unknown = signal.aborted ? signal.reason : error;
      if (cause instanceof Error && cause.message==='SERVICE_HANDOFF') {
        try {this.store.handoff(job);} catch { /* A committed receipt or explicit cancel already owns it. */ }
        return {outcome:'handoff'};
      }
      const diagnostic = failureDiagnostic(cause, stage);
      // The abort reason remains authoritative; only controlled progress scalars supply missing HTTP context.
      const context = remoteContext as FailureDiagnostic | null;
      if (signal.aborted && context && ['TIMEOUT','CANCELLED'].includes(failureCode(cause))) {
        diagnostic.stage = context.stage;
        if (context.httpStatus !== undefined) diagnostic.httpStatus = context.httpStatus;
      }
      try { this.store.fail(job, cause, diagnostic); } catch { /* A recovered receipt or superseded lease owns this batch. */ }
      const reason = failureCode(cause);
      const state=this.store.db.prepare('SELECT state FROM jobs WHERE id=?').get(job.id)?.state;
      return {outcome:reason === 'CANCELLED' ? 'cancelled' : state==='paused'?'paused':state==='quarantined'?'quarantined':'failed',reason};
    } finally { clearInterval(timer); options.signal?.removeEventListener('abort', cancelled); }
  }
  #quarantine(job: RuntimeJob, issue: string): {outcome:string} { this.store.quarantine(job, job.observations[0]!.id, issue); return {outcome:'quarantined'}; }
  /**
   * Imports (another agent's summary, an imported document) are data, not authority over what the user
   * said. A decision backed only by import evidence (or an evidence-free decision in an import-only
   * batch) may append new Sections or rework Sections whose every linked source is itself an import;
   * it can never forget, remove or replace user-derived or unlinked Sections.
   */
  #guardImports(job: RuntimeJob, decisions: Decision[], documents: DocumentSnapshot[]): void {
    const imported = new Set(job.observations.filter(o => isImportSource(o.source)).map(o => `ev_${o.id}`));
    if (!imported.size) return;
    const importOnlyBatch = imported.size === job.observations.length;
    for (const d of decisions) {
      if (d.kind === 'ignore') continue;
      const importOnly = d.evidence.length ? d.evidence.every(ref => imported.has(ref)) : importOnlyBatch;
      if (!importOnly) continue;
      if (d.kind === 'forget') throw new Error('UNAUTHORIZED_FORGET_EVIDENCE');
      for (const op of d.operations) {
        if (op.section === null) continue;
        const doc = documents.find(doc => doc.target === op.target);
        const title = doc?.sections.find(s => s.ref === op.section)?.title;
        // A manually edited document has stale title links (the receipt below clears them); a hand-edited
        // Section is the user's, so its old import links must not authorize an import to rewrite it.
        const prior = doc ? this.store.documentVersion(doc.target) : null;
        const externallyEdited = doc !== undefined && prior !== null && prior !== doc.hash;
        const sources = title === undefined || externallyEdited ? [] : this.store.sources(`${op.target}:${digest(title)}`);
        const ownedByImports = sources.length > 0 && this.store.sourceKinds(sources).every(isImportSource);
        if (!ownedByImports) throw new Error('UNAUTHORIZED_IMPORT_OVERWRITE');
      }
    }
  }
  #receipt(job: RuntimeJob, documents: DocumentSnapshot[], decisions: Decision[], updates: Map<string,string>): RuntimeReceipt & { removeTargets:string[] } {
    const associations: {target:string;sourceIds:number[]}[] = [], removeTargets:string[] = [], forget = new Set<number>(), purge = new Set<number>();
    // Manual Markdown edits invalidate title-based sidecar identities. Keep current
    // Markdown, but conservatively purge this document's short-lived source bodies
    // and stale links in the same recoverable receipt, never guess a rename.
    const externallyEdited = new Set<string>();
    for (const doc of documents) {
      const prior = this.store.documentVersion(doc.target);
      if (prior !== null && prior !== doc.hash) {
        externallyEdited.add(doc.target);
        for (const key of this.store.documentSourceKeys(doc.target)) {
          removeTargets.push(key); for (const id of this.store.sources(key)) purge.add(id);
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

    const at=Math.max(...job.observations.map(o=>Date.parse(o.observedAt))),sourceId=Math.max(...job.observations.map(o=>o.id));
    const protectedTargets=[...new Set(decisions.flatMap(d=>d.kind==='ignore'?[]:d.kind==='forget'||d.kind==='retain'&&['update','correct'].includes(d.admission)||job.observations[0]!.taskKind==='edit'?d.operations.map(op=>op.target):[]))];
    const correctionWatermarks=Number.isFinite(at)?protectedTargets.map(target=>({target,at,sourceId})):[];
    return {purgeSourceIds:[...purge],correctionWatermarks,documents:documents.map(doc => ({target:doc.target,after:updates.has(doc.target)?digest(updates.get(doc.target)!):doc.hash})),jobId:job.id,observationIds:job.observations.map(o => o.id),associations,removeTargets,forgetSourceIds:[...forget]};
  }
  close(): void { this.store.close(); }
}
function documentScope(doc: DocumentSnapshot): string { return doc.target.startsWith('project:') ? doc.target : 'global'; }
function digest(value:string):string { return createHash('sha256').update(value).digest('hex'); }
function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T> {
  return new Promise((resolve,reject) => { const abort = () => reject(signal.reason); signal.addEventListener('abort',abort,{once:true}); if(signal.aborted) abort(); promise.then(resolve,reject).finally(() => signal.removeEventListener('abort',abort)); });
}
