import { CoreError } from "../contracts/errors.js";
import type { AutoGovernBatchInput, GovernanceBatchDto, ProposeInput } from "../contracts/dto.js";
import { isAutomatedGovernanceAuthority, isGovernanceAuthority, trustedContributor, type AutomatedGovernanceAuthority, type Clock, type GovernanceAuthority, type IdGenerator } from "../contracts/ports.js";
import type { ApprovedReview, Fact, FinalOperation, GovernanceMode, Proposal, Review, ReviewExecution, SuggestedFact } from "../contracts/types.js";
import type { LockedRepositorySession } from "../repository/locked-session.js";
import { validateRecord } from "../contracts/schema-registry.js";
import { scanFact, scanReview } from "../safety/scanner.js";
import { REVIEW_REVISION_SENTINEL, knowledgeRevision, storeRevision } from "../revision/revisions.js";
import { createProposal } from "./proposal.js";
import { factMutation, proposalMutation, reviewMutation } from "./mutations.js";
import { batchId, compensationBatchId, operationId, payloadDigest } from "./governance-digest.js";

type InternalOperation = AutoGovernBatchInput["operations"][number] & { reverts_review_ids?: string[] };
type InternalBatchInput = Omit<AutoGovernBatchInput, "mode" | "operations"> & { mode: GovernanceMode; operations: InternalOperation[] };
export function autoGovernBatch(session: LockedRepositorySession, input: InternalBatchInput, authority: AutomatedGovernanceAuthority | GovernanceAuthority, clock: Clock, ids: IdGenerator): GovernanceBatchDto {
  requireAuthority(authority, input.mode); validateInput(input);
  const existing = existingBatch(session, input); if (existing) return existing;
  if (input.expected_knowledge_revision !== session.snapshot.knowledge_revision || input.expected_store_revision !== session.snapshot.store_revision) throw new CoreError("STALE_REVISION", "The repository changed before automatic governance", { current_knowledge_revision: session.snapshot.knowledge_revision, current_store_revision: session.snapshot.store_revision });
  const reverted = [...new Set(input.operations.flatMap((operation) => operation.reverts_review_ids ?? []))];
  const expectedBatch = input.mode === "compensation" ? compensationBatchId(session.snapshot.repository.repository_id, reverted, input.expected_knowledge_revision, input.expected_store_revision) : batchId(session.snapshot.repository.repository_id, input.mode, input.policy_version, input.source_digest, input.expected_knowledge_revision, input.expected_store_revision);
  if (input.batch_id !== expectedBatch) throw new CoreError("CONFLICT_DETECTED", "Batch commitment mismatch", { rule_id: "governance.batch_digest" });
  const sorted = [...input.operations].sort((a, b) => Buffer.compare(Buffer.from(a.operation_id), Buffer.from(b.operation_id)));
  const now = clock.now().toISOString(); const targetIds = new Set<string>();
  for (const operation of sorted) {
    const digest = payloadDigest(operation.proposal_input); const expected = operationId("memory_analysis_v1", input.mode, input.policy_version, operation.intent, digest, input.expected_knowledge_revision, input.expected_store_revision);
    if (operation.operation_id !== expected) throw new CoreError("CONFLICT_DETECTED", "Operation commitment mismatch", { rule_id: "governance.operation_digest" });
    if (input.mode !== "compensation") enforcePolicy(session, input.mode, operation.intent, operation.proposal_input, targetIds, now); else enforceCompensation(session, operation, targetIds);
  }
  const proposals = new Map(session.snapshot.proposals); const created: Proposal[] = [];
  for (const operation of sorted) {
    const proposal = createProposal(operation.proposal_input, trustedContributor(input.mode === "compensation" ? "local_user" : "memory_manager", operation.proposal_input.evidence.session_id), { now: () => new Date(now) }, ids);
    if (proposals.has(proposal.id)) throw new CoreError("CONFLICT_DETECTED", "Generated proposal ID already exists"); proposals.set(proposal.id, proposal); created.push(proposal);
  }
  const facts = new Map(session.snapshot.facts); const reviews = new Map(session.snapshot.reviews); const createdReviews: ApprovedReview[] = []; const resultingFactIds: string[] = [];
  for (let index = 0; index < sorted.length; index++) {
    const operation = sorted[index]!; const proposal = created[index]!; const based = storeRevision({ repository: session.snapshot.repository, facts: facts.values(), proposals: proposals.values(), reviews: reviews.values() });
    const reviewId = ids.next("review"); if (reviews.has(reviewId)) throw new CoreError("CONFLICT_DETECTED", "Generated review ID already exists");
    const planned = applyOperation(facts, proposal, operation.proposal_input, reviewId, now, ids); resultingFactIds.push(...planned.resultingFactIds);
    const execution: ReviewExecution = { mode: input.mode, batch_id: input.batch_id, operation_id: operation.operation_id, sequence: index + 1, batch_size: sorted.length, intent: operation.intent, policy_version: input.policy_version, source_digest: input.source_digest, base_knowledge_revision: input.expected_knowledge_revision, base_store_revision: input.expected_store_revision, payload_digest: payloadDigest(operation.proposal_input), reverts_review_ids: operation.reverts_review_ids ?? [] };
    let review: ApprovedReview = { schema_version: 1, id: reviewId, proposal_id: proposal.id, decision: "approved", reviewed_at: now, reviewer: { type: input.mode === "compensation" ? "local_user" : "memory_manager_policy" }, note: null, execution, final_operation: withReview(planned.finalOperation, reviewId, proposal, facts, now), based_on_store_revision: based, resulting_store_revision: REVIEW_REVISION_SENTINEL };
    validateRecord("review", review); scanReview(review); reviews.set(review.id, review);
    const resulting = storeRevision({ repository: session.snapshot.repository, facts: facts.values(), proposals: proposals.values(), reviews: reviews.values() }); review = { ...review, resulting_store_revision: resulting }; reviews.set(review.id, review); validateRecord("review", review); createdReviews.push(review);
  }
  // A later review's based revision may depend on the corrected predecessor. Rebuild the chain deterministically.
  rebuildReviewChain(session, proposals, facts, reviews, createdReviews);
  const nextKnowledge = knowledgeRevision(facts.values()); const nextStore = storeRevision({ repository: session.snapshot.repository, facts: facts.values(), proposals: proposals.values(), reviews: reviews.values() });
  const mutations = [...created.map((proposal) => proposalMutation(session.layout, proposal)), ...changedFacts(session.snapshot.facts, facts).map((fact) => factMutation(session.layout, fact)), ...createdReviews.map((review) => reviewMutation(session.layout, review))];
  session.apply(mutations, { knowledge: nextKnowledge, store: nextStore });
  return { batch_id: input.batch_id, proposals: created, reviews: createdReviews, resulting_fact_ids: resultingFactIds, knowledge_revision: nextKnowledge, store_revision: nextStore, idempotent: false };
}
function requireAuthority(value: AutomatedGovernanceAuthority | GovernanceAuthority, mode: GovernanceMode): void { if (mode === "compensation" ? !isGovernanceAuthority(value) : !isAutomatedGovernanceAuthority(value)) throw new CoreError("PERMISSION_DENIED", "A matching governance capability is required"); }
function validateInput(input: InternalBatchInput): void {
  if (!input || !Array.isArray(input.operations) || input.operations.length === 0 || input.operations.length > 100 || !new Set(["extract", "consolidate", "compensation"]).has(input.mode) || !input.policy_version) throw new CoreError("VALIDATION_FAILED", "Invalid governance batch");
  if (new Set(input.operations.map((item) => item.operation_id)).size !== input.operations.length) throw new CoreError("VALIDATION_FAILED", "Operation IDs must be unique");
}
function existingBatch(session: LockedRepositorySession, input: InternalBatchInput): GovernanceBatchDto | null {
  const reviews = [...session.snapshot.reviews.values()].filter((review) => review.execution?.batch_id === input.batch_id).sort((a, b) => (a.execution!.sequence - b.execution!.sequence));
  if (reviews.length === 0) {
    for (const review of session.snapshot.reviews.values()) if (review.execution && input.operations.some((item) => item.operation_id === review.execution!.operation_id)) throw new CoreError("CONFLICT_DETECTED", "Operation ID already belongs to another batch");
    return null;
  }
  if (reviews.length !== input.operations.length || reviews.some((review, index) => review.execution?.sequence !== index + 1 || review.execution.batch_size !== reviews.length)) throw new CoreError("STORE_UNAVAILABLE", "Stored automatic batch is incomplete");
  const expected = new Map(input.operations.map((operation) => [operation.operation_id, operation]));
  for (const review of reviews) {
    const operation = expected.get(review.execution!.operation_id); const proposal = session.snapshot.proposals.get(review.proposal_id);
    if (!operation || !proposal || proposal.source.client !== (input.mode === "compensation" ? "local_user" : "memory_manager") || review.reviewer.type !== (input.mode === "compensation" ? "local_user" : "memory_manager_policy") || review.execution!.payload_digest !== payloadDigest(operation.proposal_input) || review.execution!.intent !== operation.intent || review.execution!.policy_version !== input.policy_version || review.execution!.source_digest !== input.source_digest || review.execution!.base_knowledge_revision !== input.expected_knowledge_revision || review.execution!.base_store_revision !== input.expected_store_revision) throw new CoreError("CONFLICT_DETECTED", "Stored batch commitment differs");
  }
  const proposals = reviews.map((review) => session.snapshot.proposals.get(review.proposal_id)!); const resulting = reviews.flatMap((review) => review.decision === "approved" ? review.final_operation.resulting_fact_ids : []);
  return { batch_id: input.batch_id, proposals, reviews, resulting_fact_ids: resulting, knowledge_revision: session.snapshot.knowledge_revision, store_revision: session.snapshot.store_revision, idempotent: true };
}
function enforceCompensation(session: LockedRepositorySession, operation: InternalOperation, touched: Set<string>): void {
  if (!operation.reverts_review_ids?.length || operation.proposal_input.confidence !== "high" || operation.proposal_input.evidence.provenance_type !== "user_correction") throw new CoreError("PERMISSION_DENIED", "Compensation requires explicit local audit edges");
  for (const reviewId of operation.reverts_review_ids) { const review = session.snapshot.reviews.get(reviewId); if (!review || review.decision !== "approved") throw new CoreError("CONFLICT_DETECTED", "Compensation review edge does not exist", { record_id: reviewId }); }
  for (const id of operation.proposal_input.target_fact_ids) { if (touched.has(id)) throw new CoreError("CONFLICT_DETECTED", "A compensation target may appear only once", { record_id: id }); touched.add(id); const target = session.snapshot.facts.get(id); if (!target || target.status !== "confirmed") throw new CoreError("CONFLICT_DETECTED", "Compensation target is no longer current", { record_id: id }); }
}
function enforcePolicy(session: LockedRepositorySession, mode: AutoGovernBatchInput["mode"], intent: AutoGovernBatchInput["operations"][number]["intent"], input: ProposeInput, touched: Set<string>, reviewedAt: string): void {
  if (input.confidence !== "high") throw new CoreError("PERMISSION_DENIED", "Automatic governance requires high confidence");
  const expectedOperation = intent === "add" ? "add_fact" : intent === "expire" ? "expire_fact" : "supersede_fact"; if (input.operation !== expectedOperation) throw new CoreError("VALIDATION_FAILED", "Intent does not match the canonical operation");
  if (mode === "extract" && !new Set(["add", "modify", "replace", "expire"]).has(intent)) throw new CoreError("PERMISSION_DENIED", "Intent is not allowed during extract");
  if (mode === "extract" && new Set(["modify", "replace", "expire"]).has(intent) && input.evidence.provenance_type !== "user_correction") throw new CoreError("PERMISSION_DENIED", "Extract mutation requires explicit user-correction provenance");
  if (mode === "consolidate" && !new Set(["add", "merge", "distill", "archive"]).has(intent)) throw new CoreError("PERMISSION_DENIED", "Intent is not allowed during consolidate");
  if (new Set(["modify", "replace", "archive"]).has(intent) && input.target_fact_ids.length !== 1 || intent === "merge" && input.target_fact_ids.length < 2) throw new CoreError("VALIDATION_FAILED", "Intent target cardinality is invalid");
  if (input.operation === "add_fact" && input.suggested_fact?.priority === "core") throw new CoreError("PERMISSION_DENIED", "Automatic governance cannot create core facts");
  if (input.suggested_fact && intent !== "archive") { const validFrom = input.suggested_fact.valid_from ?? reviewedAt; const expiresAt = input.suggested_fact.expires_at; if (input.suggested_fact.priority === "archive") throw new CoreError("PERMISSION_DENIED", "Only archive intent may create archive priority"); if (Date.parse(validFrom) > Date.parse(reviewedAt) || expiresAt !== null && (Date.parse(expiresAt) <= Date.parse(reviewedAt) || Date.parse(expiresAt) <= Date.parse(validFrom))) throw new CoreError("VALIDATION_FAILED", "Automatic replacement must be current at review time"); }
  for (const id of input.target_fact_ids) {
    if (touched.has(id)) throw new CoreError("CONFLICT_DETECTED", "A target may appear only once in a batch", { record_id: id }); touched.add(id);
    const target = session.snapshot.facts.get(id); if (!target || target.status !== "confirmed") throw new CoreError("CONFLICT_DETECTED", "Every target must be current", { record_id: id });
    if (input.suggested_fact && JSON.stringify(input.suggested_fact.scope) !== JSON.stringify(target.scope)) throw new CoreError("PERMISSION_DENIED", "Automatic governance cannot move a fact across scopes");
    if (intent === "archive" && input.suggested_fact && (input.suggested_fact.statement !== target.statement || input.suggested_fact.kind !== target.kind || input.suggested_fact.priority !== "archive" || JSON.stringify(input.suggested_fact.tags) !== JSON.stringify(target.tags) || input.suggested_fact.expires_at !== target.validity.expires_at || input.suggested_fact.valid_from !== target.validity.valid_from)) throw new CoreError("VALIDATION_FAILED", "Archive must be a semantic clone with archive priority");
    if (target.priority === "core") {
      const correction = mode === "extract" && input.evidence.provenance_type === "user_correction" && new Set(["modify", "replace"]).has(intent) && input.suggested_fact?.priority === "core";
      if (!correction) throw new CoreError("PERMISSION_DENIED", "Core facts require an explicit user correction");
    }
  }
}
function applyOperation(facts: Map<string, Fact>, proposal: Proposal, input: ProposeInput, reviewId: string, now: string, ids: IdGenerator): { finalOperation: FinalOperation; resultingFactIds: string[] } {
  const targets = input.target_fact_ids.map((id) => facts.get(id)!); const resulting: string[] = [];
  if (input.operation === "supersede_fact" && input.suggested_fact?.valid_from !== null && input.suggested_fact?.valid_from !== undefined && Date.parse(input.suggested_fact.valid_from) > Date.parse(now)) throw new CoreError("VALIDATION_FAILED", "A superseding fact cannot begin after review");
  if (input.operation === "expire_fact") for (const target of targets) if (Date.parse(input.suggested_expiration!.expires_at) > Date.parse(now) || Date.parse(input.suggested_expiration!.expires_at) <= Date.parse(target.validity.valid_from)) throw new CoreError("VALIDATION_FAILED", "Expiration time is outside the allowed interval");
  if (input.operation === "add_fact" || input.operation === "supersede_fact") {
    const suggested = input.suggested_fact!; const factId = ids.next("fact"); if (facts.has(factId)) throw new CoreError("CONFLICT_DETECTED", "Generated fact ID already exists"); resulting.push(factId);
    const normalized = { ...suggested, valid_from: suggested.valid_from ?? now };
    const fact = makeFact(normalized, proposal, reviewId, factId, now, input.operation === "supersede_fact" ? input.target_fact_ids : []); facts.set(fact.id, fact);
    if (input.operation === "supersede_fact") for (const target of targets) facts.set(target.id, { ...target, status: "superseded" });
    return { finalOperation: input.operation === "add_fact" ? { operation: "add_fact", suggested_fact: normalized, resulting_fact_ids: resulting as [string] } : { operation: "supersede_fact", target_fact_ids: input.target_fact_ids, suggested_fact: normalized, resulting_fact_ids: resulting as [string] }, resultingFactIds: resulting };
  }
  const expiration = input.suggested_expiration!; for (const target of targets) facts.set(target.id, { ...target, status: "expired", validity: { ...target.validity, expires_at: expiration.expires_at } });
  return { finalOperation: { operation: "expire_fact", target_fact_ids: input.target_fact_ids, expires_at: expiration.expires_at, reason: expiration.reason, resulting_fact_ids: [] }, resultingFactIds: [] };
}
function makeFact(suggested: SuggestedFact, proposal: Proposal, reviewId: string, factId: string, now: string, supersedes: string[]): Fact {
  const fact: Fact = { schema_version: 1, id: factId, statement: suggested.statement, kind: suggested.kind, scope: suggested.scope, status: "confirmed", priority: suggested.priority, provenance: { type: proposal.evidence.provenance_type, source_client: proposal.source.client, session_id: proposal.evidence.session_id, reference: proposal.evidence.reference, ...(proposal.evidence.note !== undefined ? { note: proposal.evidence.note } : {}), observed_at: proposal.evidence.observed_at, received_at: proposal.source.received_at }, governance: { proposal_id: proposal.id, review_id: reviewId, confirmed_at: now }, validity: { valid_from: suggested.valid_from ?? now, expires_at: suggested.expires_at, supersedes }, tags: suggested.tags }; scanFact(fact); return fact;
}
function withReview(final: FinalOperation, _reviewId: string, _proposal: Proposal, _facts: Map<string, Fact>, _now: string): FinalOperation { return final; }
function rebuildReviewChain(session: LockedRepositorySession, proposals: Map<string, Proposal>, facts: Map<string, Fact>, reviews: Map<string, Review>, created: ApprovedReview[]): void {
  const baseReviews = new Map(session.snapshot.reviews); const replayFacts = new Map(session.snapshot.facts);
  // Reconstruct only revision edges; final facts already represent the atomic batch post-image.
  let prior = storeRevision({ repository: session.snapshot.repository, facts: replayFacts.values(), proposals: proposals.values(), reviews: baseReviews.values() });
  for (const review of created) {
    const final = review.final_operation;
    if (final.operation === "add_fact" || final.operation === "supersede_fact") for (const id of final.resulting_fact_ids) replayFacts.set(id, facts.get(id)!);
    if (final.operation === "supersede_fact") for (const id of final.target_fact_ids) replayFacts.set(id, facts.get(id)!);
    if (final.operation === "expire_fact") for (const id of final.target_fact_ids) replayFacts.set(id, facts.get(id)!);
    let corrected: ApprovedReview = { ...review, based_on_store_revision: prior, resulting_store_revision: REVIEW_REVISION_SENTINEL }; baseReviews.set(corrected.id, corrected);
    const post = storeRevision({ repository: session.snapshot.repository, facts: replayFacts.values(), proposals: proposals.values(), reviews: baseReviews.values() }); corrected = { ...corrected, resulting_store_revision: post }; baseReviews.set(corrected.id, corrected); reviews.set(corrected.id, corrected); Object.assign(review, corrected); prior = post;
  }
}
function changedFacts(before: ReadonlyMap<string, Fact>, after: ReadonlyMap<string, Fact>): Fact[] { return [...after.values()].filter((fact) => JSON.stringify(before.get(fact.id)) !== JSON.stringify(fact)); }
