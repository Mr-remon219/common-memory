import { CoreError, toCoreError } from "../contracts/errors.js";
import type { ApplyUndoInput, AutoGovernBatchInput, ContextPackInput, EditApproveInput, GetInput, GovernanceInput, GovernanceLogInput, ProposeInput, RecallPlan, SearchInput, SummaryInput, UndoPreviewInput } from "../contracts/dto.js";
import type { AutomatedGovernanceAuthority, Clock, FaultInjector, GovernanceAuthority, IdGenerator, TrustedContributor } from "../contracts/ports.js";
import { noFaults, randomIdGenerator, systemClock } from "../contracts/ports.js";
import { buildContextPack } from "../context/context-pack.js";
import { buildSummary } from "../context/summary.js";
import { approveProposal, rejectProposal } from "../governance/governance.js";
import { autoGovernBatch as executeAutoGovernBatch } from "../governance/auto-batch.js";
import { applyUndo as executeUndo, previewUndo as buildUndoPreview } from "../governance/undo.js";
import { proposalHints } from "../governance/hints.js";
import { proposalMutation } from "../governance/mutations.js";
import { createProposal } from "../governance/proposal.js";
import { probeIndexCapability } from "../index/capability.js";
import { rebuildIndex as rebuildDerivedIndex } from "../index/rebuild.js";
import { eligibleFacts } from "../query/read.js";
import { governanceLog } from "../query/governance-log.js";
import { executeRecall } from "../query/recall.js";
import { RepositoryLayout } from "../repository/layout.js";
import { diagnostics } from "../repository/diagnostics.js";
import { bootstrapRepository } from "../repository/initializer.js";
import { LockedRepositorySession } from "../repository/locked-session.js";
import { storeRevision } from "../revision/revisions.js";
import { searchFacts } from "../search/search.js";
import { failure, success, type CoreResponse } from "./responses.js";

export interface CoreServiceOptions { dataRoot: string; clock?: Clock; ids?: IdGenerator; faults?: FaultInjector; lockTimeoutMs?: number }
export class CoreService {
  readonly #layout: RepositoryLayout; readonly #clock: Clock; readonly #ids: IdGenerator; readonly #faults: FaultInjector; readonly #lockTimeout: number;
  constructor(options: CoreServiceOptions) {
    if (Number(process.versions.node.split(".")[0]) !== 24) throw new CoreError("PROTOCOL_ERROR", "Common Memory Core requires Node.js 24.x");
    this.#layout = new RepositoryLayout(options.dataRoot); this.#clock = options.clock ?? systemClock; this.#ids = options.ids ?? randomIdGenerator; this.#faults = options.faults ?? noFaults; this.#lockTimeout = options.lockTimeoutMs ?? 2_000;
  }
  initialize(): CoreResponse<ReturnType<typeof diagnostics>> {
    try { const snapshot = bootstrapRepository(this.#layout, this.#clock, this.#ids, this.#faults, this.#lockTimeout); return success(snapshot, diagnostics(snapshot)); }
    catch (error) { return failure(toCoreError(error)); }
  }
  diagnose() { return this.#withSession((session) => ({ ...diagnostics(session.snapshot), index_capability: safeCapability() })); }
  get(input: GetInput) { const now = this.#clock.now().toISOString(); return this.#withSession((session) => ({ facts: eligibleFacts(session.snapshot, input, now), evaluated_at: input.valid_at === undefined ? now : new Date(input.valid_at).toISOString() })); }
  summary(input: SummaryInput) { const now = this.#clock.now().toISOString(); return this.#withSession((session) => buildSummary(session.snapshot, input, now)); }
  search(input: SearchInput) { const now = this.#clock.now().toISOString(); return this.#withSession((session) => searchFacts(session, input, now)); }
  contextPack(input: ContextPackInput) {
    const now = this.#clock.now().toISOString(); return this.#withSession((session) => {
      try { const results = searchFacts(session, { ...input, query: input.task, include_history: false }, now); const historical = input.include_history && input.time_range ? searchFacts(session, { ...input, query: input.task, include_history: true }, now) : []; return buildContextPack(session.snapshot, input, now, results, historical, false); }
      catch (error) { if (error instanceof CoreError && error.code === "INDEX_OUTDATED") return buildContextPack(session.snapshot, input, now, [], [], true); throw error; }
    });
  }
  recall(plan: RecallPlan) { const now = this.#clock.now().toISOString(); return this.#withSession((session) => executeRecall(session, plan, now)); }
  propose(input: ProposeInput, contributor: TrustedContributor) {
    return this.#withSession((session) => { const proposal = createProposal(input, contributor, this.#clock, this.#ids); if (session.snapshot.proposals.has(proposal.id)) throw new CoreError("CONFLICT_DETECTED", "Generated proposal ID already exists"); const hints = proposalHints(session.snapshot, proposal); const proposals = new Map(session.snapshot.proposals).set(proposal.id, proposal); const nextStore = storeRevision({ repository: session.snapshot.repository, facts: session.snapshot.facts.values(), proposals: proposals.values(), reviews: session.snapshot.reviews.values() }); session.apply([proposalMutation(session.layout, proposal)], { knowledge: session.snapshot.knowledge_revision, store: nextStore }); return { proposal_id: proposal.id, status: "pending" as const, hints, store_revision: nextStore }; });
  }
  approve(input: GovernanceInput, authority: GovernanceAuthority) { return this.#withSession((session) => approveProposal(session, input, authority, this.#clock, this.#ids)); }
  editApprove(input: EditApproveInput, authority: GovernanceAuthority) { return this.#withSession((session) => approveProposal(session, input, authority, this.#clock, this.#ids, input.edits)); }
  reject(input: GovernanceInput, authority: GovernanceAuthority) { return this.#withSession((session) => rejectProposal(session, input, authority, this.#clock, this.#ids)); }
  autoGovernBatch(input: AutoGovernBatchInput, authority: AutomatedGovernanceAuthority) { return this.#withSession((session) => executeAutoGovernBatch(session, input, authority, this.#clock, this.#ids)); }
  listGovernance(input: GovernanceLogInput = {}) { return this.#withSession((session) => governanceLog(session.snapshot, input)); }
  getGovernanceBatch(batchId: string) { return this.listGovernance({ batch_id: batchId, limit: 100 }); }
  automaticSourceProcessed(sourceDigest: string, mode: "extract" | "consolidate") { return this.#withSession((session) => [...session.snapshot.reviews.values()].some((review) => review.execution?.source_digest === sourceDigest && review.execution.mode === mode)); }
  previewUndo(input: UndoPreviewInput) { return this.#withSession((session) => buildUndoPreview(session.snapshot, input, this.#clock)); }
  applyUndo(input: ApplyUndoInput, authority: GovernanceAuthority) { return this.#withSession((session) => executeUndo(session, input, authority, this.#clock, this.#ids)); }
  repositoryInfo() { return this.#withSession((session) => ({ repository_id: session.snapshot.repository.repository_id, knowledge_revision: session.snapshot.knowledge_revision, store_revision: session.snapshot.store_revision })); }
  rebuildIndex() { return this.#withSession((session) => { rebuildDerivedIndex(this.#layout, session.snapshot, session.faults); session.reload(); return { rebuilt: true, index_revision: session.snapshot.index_revision }; }); }
  #withSession<T>(operation: (session: LockedRepositorySession) => T): CoreResponse<T> {
    let session: LockedRepositorySession | undefined; let response: CoreResponse<T>;
    try { session = new LockedRepositorySession(this.#layout, this.#ids, this.#faults, this.#lockTimeout); const data = operation(session); response = success(session.snapshot, data); }
    catch (error) { response = failure(toCoreError(error), session?.snapshot); }
    if (session) try { session.close(); } catch { /* Never replace a stable completed response with cleanup failure. */ }
    return response;
  }
}
function safeCapability(): ReturnType<typeof probeIndexCapability> | { available: false; error: "INDEX_OUTDATED" } { try { return probeIndexCapability(); } catch { return { available: false, error: "INDEX_OUTDATED" }; } }
