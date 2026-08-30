import { CoreError } from "../contracts/errors.js";
import type { ApplyUndoInput, UndoPlanItem, UndoPreviewDto, UndoPreviewInput } from "../contracts/dto.js";
import type { Clock, GovernanceAuthority, IdGenerator } from "../contracts/ports.js";
import type { ApprovedReview, Fact, GovernanceIntent, RepositorySnapshot, SuggestedFact } from "../contracts/types.js";
import type { LockedRepositorySession } from "../repository/locked-session.js";
import { compensationBatchId, operationId, payloadDigest, planDigest, sourceDigest } from "./governance-digest.js";
import { autoGovernBatch } from "./auto-batch.js";

export function previewUndo(snapshot: RepositorySnapshot, input: UndoPreviewInput, clock: Clock): UndoPreviewDto {
  if (!Array.isArray(input.review_ids) || input.review_ids.length === 0 || new Set(input.review_ids).size !== input.review_ids.length) throw new CoreError("VALIDATION_FAILED", "Undo review IDs must be a non-empty set");
  const reviewIds = [...input.review_ids].sort((a, b) => a.localeCompare(b, "en"));
  for (const existing of snapshot.reviews.values()) if (existing.execution?.mode === "compensation" && existing.execution.reverts_review_ids.some((id) => reviewIds.includes(id))) throw new CoreError("CONFLICT_DETECTED", "A review already has a compensation edge");
  const plan: UndoPlanItem[] = [];
  for (const reviewId of reviewIds) {
    const review = snapshot.reviews.get(reviewId); if (!review || review.decision !== "approved") throw new CoreError("CONFLICT_DETECTED", "Only approved reviews can be compensated", { record_id: reviewId });
    plan.push(...planReview(snapshot, review));
  }
  const plannedAt = clock.now().toISOString(); const identity = { base_knowledge_revision: snapshot.knowledge_revision, base_store_revision: snapshot.store_revision, planned_at: plannedAt, review_ids: reviewIds, plan };
  return { compensation_batch_id: compensationBatchId(snapshot.repository.repository_id, reviewIds, snapshot.knowledge_revision, snapshot.store_revision), plan_digest: planDigest(identity), base_knowledge_revision: snapshot.knowledge_revision, base_store_revision: snapshot.store_revision, planned_at: plannedAt, review_ids: reviewIds, plan };
}
export function applyUndo(session: LockedRepositorySession, input: ApplyUndoInput, authority: GovernanceAuthority, clock: Clock, ids: IdGenerator) {
  const preview = input?.preview; if (!preview) throw new CoreError("VALIDATION_FAILED", "Undo preview is required");
  const identity = { base_knowledge_revision: preview.base_knowledge_revision, base_store_revision: preview.base_store_revision, planned_at: preview.planned_at, review_ids: preview.review_ids, plan: preview.plan };
  if (planDigest(identity) !== preview.plan_digest || compensationBatchId(session.snapshot.repository.repository_id, preview.review_ids, preview.base_knowledge_revision, preview.base_store_revision) !== preview.compensation_batch_id) throw new CoreError("CONFLICT_DETECTED", "Undo preview identity mismatch");
  const existing = hasExistingCompensation(session.snapshot, preview.compensation_batch_id);
  if (!existing) { const fresh = previewUndoAt(session.snapshot, preview.review_ids, preview.planned_at); if (fresh.plan_digest !== preview.plan_digest) throw new CoreError("CONFLICT_DETECTED", "Undo plan no longer matches repository history"); }
  const source = sourceDigest(preview.review_ids.map((id) => ({ observation_id: id, observation_digest: preview.plan_digest, scope: "local-compensation", provenance: "user_correction" })));
  const operations = preview.plan.map((item, index) => {
    const suggested = suggestedFrom(item); const proposal = item.operation === "archive_result"
      ? { operation: "supersede_fact" as const, target_fact_ids: [item.fact_id], suggested_fact: { ...suggested, priority: "archive" as const }, evidence: evidence(item.reverts_review_id, preview.planned_at), reasoning: "Local compensation archives the prior result", confidence: "high" as const }
      : { operation: "add_fact" as const, target_fact_ids: [] as [], suggested_fact: suggested, evidence: evidence(item.reverts_review_id, preview.planned_at), reasoning: "Local compensation restores prior semantics", confidence: "high" as const };
    const intent: GovernanceIntent = item.operation === "archive_result" ? "archive" : "add"; const payload = payloadDigest(proposal);
    return { operation_id: operationId("memory_analysis_v1", "compensation", "compensation-v1", intent, payload, preview.base_knowledge_revision, preview.base_store_revision), intent, proposal_input: proposal, reverts_review_ids: [item.reverts_review_id], index };
  }).sort((a, b) => a.operation_id.localeCompare(b.operation_id, "en")).map(({ index: _index, ...operation }) => operation);
  return autoGovernBatch(session, { batch_id: preview.compensation_batch_id, mode: "compensation", policy_version: "compensation-v1", source_digest: source, expected_knowledge_revision: preview.base_knowledge_revision, expected_store_revision: preview.base_store_revision, operations }, authority, clock, ids);
}
function previewUndoAt(snapshot: RepositorySnapshot, reviewIds: readonly string[], plannedAt: string): UndoPreviewDto { const fixed: Clock = { now: () => new Date(plannedAt) }; return previewUndoWithoutCompensationConflict(snapshot, { review_ids: [...reviewIds] }, fixed); }
function previewUndoWithoutCompensationConflict(snapshot: RepositorySnapshot, input: UndoPreviewInput, clock: Clock): UndoPreviewDto {
  const filtered = new Map([...snapshot.reviews].filter(([, review]) => review.execution?.mode !== "compensation")); return previewUndo({ ...snapshot, reviews: filtered }, input, clock);
}
function hasExistingCompensation(snapshot: RepositorySnapshot, batchId: string): boolean { return [...snapshot.reviews.values()].some((review) => review.execution?.mode === "compensation" && review.execution.batch_id === batchId); }
function planReview(snapshot: RepositorySnapshot, review: ApprovedReview): UndoPlanItem[] {
  const final = review.final_operation; const plan: UndoPlanItem[] = [];
  if (final.operation === "add_fact" || final.operation === "supersede_fact") {
    const result = snapshot.facts.get(final.resulting_fact_ids[0]); if (!result || result.status !== "confirmed") throw new CoreError("CONFLICT_DETECTED", "Governance result has downstream changes", { record_id: final.resulting_fact_ids[0] });
    plan.push(item(review.id, "archive_result", result));
  }
  if (final.operation === "supersede_fact" || final.operation === "expire_fact") for (const id of final.target_fact_ids) {
    const fact = snapshot.facts.get(id); const expected = final.operation === "supersede_fact" ? "superseded" : "expired"; if (!fact || fact.status !== expected) throw new CoreError("CONFLICT_DETECTED", "Governance target has downstream changes", { record_id: id }); plan.push(item(review.id, "restore_fact", originalSemantic(snapshot, fact)));
  }
  return plan;
}
function originalSemantic(snapshot: RepositorySnapshot, fact: Fact): Fact { const origin = snapshot.reviews.get(fact.governance.review_id); if (!origin || origin.decision !== "approved" || (origin.final_operation.operation !== "add_fact" && origin.final_operation.operation !== "supersede_fact")) return fact; const suggested = origin.final_operation.suggested_fact; return { ...fact, statement: suggested.statement, kind: suggested.kind, scope: suggested.scope, priority: suggested.priority, validity: { ...fact.validity, valid_from: suggested.valid_from ?? origin.reviewed_at, expires_at: suggested.expires_at }, tags: suggested.tags }; }
function item(reviewId: string, operation: UndoPlanItem["operation"], fact: Fact): UndoPlanItem { return { reverts_review_id: reviewId, operation, fact_id: fact.id, statement: fact.statement, kind: fact.kind, scope: fact.scope, priority: fact.priority, valid_from: fact.validity.valid_from, expires_at: fact.validity.expires_at, tags: [...fact.tags] }; }
function suggestedFrom(item: UndoPlanItem): SuggestedFact { return { statement: item.statement, kind: item.kind, scope: item.scope, priority: item.priority, valid_from: item.valid_from, expires_at: item.expires_at, tags: item.tags }; }
function evidence(reviewId: string, observedAt: string) { return { provenance_type: "user_correction" as const, session_id: null, reference: `undo:${reviewId}`, observed_at: observedAt }; }
