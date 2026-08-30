import { randomUUID } from "node:crypto";
import type { AutoGovernBatchInput } from "../core/contracts/dto.js";
import { CoreError } from "../core/contracts/errors.js";
import { automatedGovernanceAuthority } from "../core/contracts/ports.js";
import type { Fact, Revision } from "../core/contracts/types.js";
import { batchId, operationId, payloadDigest, sourceDigest } from "../core/governance/governance-digest.js";
import { externalPreflight } from "../core/safety/external-preflight.js";
import type { CoreService } from "../core/service/core-service.js";
import { validateMemoryAnalysis } from "./analysis-validator.js";
import { compileAction } from "./compiler.js";
import type { MemoryAnalysisMode } from "./contracts/analysis.js";
import { memoryAnalysisSchema } from "./contracts/analysis-schema.js";
import type { RemoteDisclosurePolicy } from "./contracts/disclosure.js";
import { validateDisclosurePolicy } from "./contracts/disclosure.js";
import { MemoryModelError } from "./contracts/errors.js";
import type { MemoryModelPort } from "./contracts/model-port.js";
import type { ObservationReference, ObservationSourcePort } from "./contracts/observation.js";
import type { MemoryRunResult } from "./contracts/run.js";
import { enforceLocalMemoryPolicy } from "./policy.js";
import { CONSOLIDATE_PROMPT_V1 } from "./prompts/consolidate-v1.js";
import { EXTRACT_PROMPT_V1 } from "./prompts/extract-v1.js";
import { resolveObservations, retrieveCandidates } from "./retrieval.js";

export interface MemoryManagerOptions {
  core: CoreService; model: MemoryModelPort; observations: ObservationSourcePort; disclosurePolicy: RemoteDisclosurePolicy;
  policyVersion?: string; requestId?: () => string; enqueueDeferredExtract?: (references: readonly ObservationReference[]) => Promise<void> | void;
}
export interface MemoryRunInput { observations: readonly ObservationReference[]; signal?: AbortSignal; deadlineMs?: number }
export class MemoryManager {
  readonly #core: CoreService; readonly #model: MemoryModelPort; readonly #observations: ObservationSourcePort; readonly #policy: RemoteDisclosurePolicy; readonly #policyVersion: string; readonly #requestId: () => string; readonly #enqueue?: MemoryManagerOptions["enqueueDeferredExtract"];
  constructor(options: MemoryManagerOptions) { validateDisclosurePolicy(options.disclosurePolicy); this.#core = options.core; this.#model = options.model; this.#observations = options.observations; this.#policy = Object.freeze({ ...options.disclosurePolicy, allowedScopes: Object.freeze([...options.disclosurePolicy.allowedScopes]), allowedProvenance: Object.freeze([...options.disclosurePolicy.allowedProvenance]) }); this.#policyVersion = options.policyVersion ?? "memory-policy-v1"; this.#requestId = options.requestId ?? (() => `req_${randomUUID().replaceAll("-", "")}`); this.#enqueue = options.enqueueDeferredExtract; }
  extract(input: MemoryRunInput): Promise<MemoryRunResult> { return this.#run("extract", input); }
  consolidate(input: MemoryRunInput): Promise<MemoryRunResult> { return this.#run("consolidate", input); }
  async #run(mode: MemoryAnalysisMode, input: MemoryRunInput): Promise<MemoryRunResult> {
    const deadlineMs = input.deadlineMs ?? (mode === "extract" ? 1_500 : 30_000);
    for (let attempt = 0; attempt < 2; attempt++) {
      let modelCalled = false;
      try {
        if (input.signal?.aborted) return { outcome: "cancelled", reason_code: "CANCELLED" };
        const resolved = await resolveObservations(this.#observations, input.observations, this.#policy, input.signal);
        const snapshot = this.#consistentSnapshot(this.#policy.allowedScopes); const requestId = this.#requestId();
        const evidence = new Map(resolved.map((item, index) => [`ev_${index + 1}`, item])); const candidates = new Map(snapshot.facts.map((fact) => [fact.id, fact]));
        const projection = freeze({ contract_version: "memory_analysis_v1", request_id: requestId, mode, based_on_knowledge_revision: snapshot.knowledgeRevision, based_on_store_revision: snapshot.storeRevision, excerpts: [...evidence].map(([id, item]) => ({ id, text: item.text, scope: item.scope, provenance: item.provenance, observed_at: item.observedAt })), candidates: snapshot.facts.map(candidateProjection) });
        externalPreflight(projection, this.#policy);
        modelCalled = true; const result = await this.#model.analyze({ prompt: mode === "extract" ? EXTRACT_PROMPT_V1 : CONSOLIDATE_PROMPT_V1, projection, schema: memoryAnalysisSchema }, { requestId, deadlineMs, ...(input.signal ? { signal: input.signal } : {}) });
        if (result.kind === "refusal") return { outcome: "refused", refusal: { category: result.category, fingerprint: result.fingerprint }, usage: result.usage };
        const analysis = validateMemoryAnalysis(result.body, { requestId, mode, knowledgeRevision: snapshot.knowledgeRevision, storeRevision: snapshot.storeRevision, evidenceRefs: new Set(evidence.keys()), candidateFactIds: new Set(candidates.keys()), allowedScopes: new Set(this.#policy.allowedScopes), maxWriteActions: mode === "extract" ? 3 : 8 });
        enforceLocalMemoryPolicy(analysis, mode, candidates, new Map([...evidence].map(([id, item]) => [id, item.provenance])));
        const actionable = analysis.actions.filter((action): action is typeof action & { action: Exclude<typeof action.action, "no_op"> } => action.action !== "no_op"); if (actionable.length === 0) return { outcome: "no_op", usage: result.usage };
        const operations = actionable.map((action) => ({ action, proposal: compileAction(action, evidence, candidates)! }));
        const source = sourceDigest(resolved.map((item) => ({ observation_id: item.observationId, observation_digest: item.digest, scope: item.scope, provenance: item.provenance })));
        const operationInputs = operations.map(({ action, proposal }) => { const payload = payloadDigest(proposal); return { operation_id: operationId("memory_analysis_v1", mode, this.#policyVersion, action.action, payload, snapshot.knowledgeRevision, snapshot.storeRevision), intent: action.action, proposal_input: proposal }; });
        const autoInput: AutoGovernBatchInput = { batch_id: batchId(snapshot.repositoryId, mode, this.#policyVersion, source, snapshot.knowledgeRevision, snapshot.storeRevision), mode, policy_version: this.#policyVersion, source_digest: source, expected_knowledge_revision: snapshot.knowledgeRevision, expected_store_revision: snapshot.storeRevision, operations: operationInputs };
        if (input.signal?.aborted) return { outcome: "cancelled", reason_code: "CANCELLED" };
        const committed = this.#core.autoGovernBatch(autoInput, automatedGovernanceAuthority());
        if (committed.ok) return { outcome: committed.data.idempotent ? "idempotent" : "committed", batch: committed.data, usage: result.usage };
        if (committed.error.code === "STALE_REVISION" && attempt === 0) continue;
        if (committed.error.code === "STALE_REVISION") return { outcome: "deferred", reason_code: "STALE_REVISION", usage: result.usage };
        return { outcome: committed.error.code === "PERMISSION_DENIED" || committed.error.code === "VALIDATION_FAILED" ? "blocked" : "failed", reason_code: committed.error.code, usage: result.usage };
      } catch (error) {
        if (error instanceof MemoryModelError) {
          if (error.code === "CANCELLED") return { outcome: "cancelled", reason_code: error.code };
          if (error.code === "TIMEOUT" && mode === "extract" && !input.signal?.aborted && this.#enqueue) { await this.#enqueue(input.observations); return { outcome: "deferred", reason_code: "TIMEOUT" }; }
          return { outcome: error.code === "TIMEOUT" || error.code === "RATE_LIMITED" || error.code === "UNAVAILABLE" ? "deferred" : "failed", reason_code: error.code };
        }
        if (input.signal?.aborted || error instanceof DOMException && error.name === "AbortError") return { outcome: "cancelled", reason_code: "CANCELLED" };
        const code = error instanceof CoreError ? error.code : "INVALID_ANALYSIS";
        if (code === "STALE_REVISION") return { outcome: "deferred", reason_code: code };
        return { outcome: code === "PERMISSION_DENIED" || code === "SENSITIVE_CONTENT_REJECTED" || code === "VALIDATION_FAILED" || !modelCalled ? "blocked" : "failed", reason_code: code };
      }
    }
    return { outcome: "deferred", reason_code: "STALE_REVISION" };
  }
  #consistentSnapshot(scopes: readonly string[]): { facts: Fact[]; knowledgeRevision: Revision; storeRevision: Revision; repositoryId: string } {
    for (let attempt = 0; attempt < 2; attempt++) { const candidates = retrieveCandidates(this.#core, scopes); const info = this.#core.repositoryInfo(); if (!info.ok) throw new CoreError(info.error.code as never, info.error.message, info.error.details); if (info.data.knowledge_revision === candidates.knowledgeRevision && info.data.store_revision === candidates.storeRevision) return { facts: candidates.facts, knowledgeRevision: candidates.knowledgeRevision, storeRevision: candidates.storeRevision, repositoryId: info.data.repository_id }; }
    throw new CoreError("STALE_REVISION", "Could not obtain a consistent repository snapshot");
  }
}
function candidateProjection(fact: Fact): object { return { fact_id: fact.id, statement: fact.statement, kind: fact.kind, scope: scopeToken(fact), priority: fact.priority, valid_from: fact.validity.valid_from, expires_at: fact.validity.expires_at, tags: fact.tags }; }
function scopeToken(fact: Fact): string { return fact.scope.type === "global" ? "global" : `${fact.scope.type}:${fact.scope.id}`; }
function freeze<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child); } return value; }
