import { CoreError } from "../contracts/errors.js";
import type { Fact, Proposal, RepositoryMetadata, Review } from "../contracts/types.js";
import type { ProposeInput } from "../contracts/dto.js";
import { normalizeSemantic } from "../serialization/normalize.js";
import { storeRevision } from "../revision/revisions.js";
import { batchId, compensationBatchId, operationId, payloadDigest } from "../governance/governance-digest.js";

function same(a: unknown, b: unknown): boolean { return JSON.stringify(normalizeSemantic(a)) === JSON.stringify(normalizeSemantic(b)); }
function unavailable(rule: string, id?: string): never { throw new CoreError("STORE_UNAVAILABLE", "Repository integrity validation failed", { violations: [{ rule_id: rule, ...(id ? { record_id: id } : {}) }] }); }
export function validateIntegrity(repository: RepositoryMetadata, facts: ReadonlyMap<string, Fact>, proposals: ReadonlyMap<string, Proposal>, reviews: ReadonlyMap<string, Review>): void {
  const reviewsByProposal = new Map<string, Review>();
  const terminalTargets = new Map<string, string>();
  const operationIds = new Set<string>(); const compensationEdges = new Map<string, string>();
  for (const review of reviews.values()) {
    if (review.decision !== "approved" || review.final_operation.operation === "add_fact") continue;
    for (const targetId of review.final_operation.target_fact_ids) {
      if (terminalTargets.has(targetId)) unavailable("integrity.duplicate_terminal_review", targetId);
      terminalTargets.set(targetId, review.id);
    }
  }
  for (const review of reviews.values()) {
    const proposal = proposals.get(review.proposal_id); if (!proposal) unavailable("integrity.missing_proposal", review.id);
    validateExecutionIdentity(proposal, review, operationIds, compensationEdges);
    if (reviewsByProposal.has(review.proposal_id)) unavailable("integrity.duplicate_review", review.proposal_id);
    reviewsByProposal.set(review.proposal_id, review);
    if (review.decision === "rejected") continue;
    const final = review.final_operation;
    if (proposal.operation !== final.operation) unavailable("integrity.operation_mismatch", review.id);
    if (final.operation === "add_fact" || final.operation === "supersede_fact") {
      for (const factId of final.resulting_fact_ids) {
        const fact = facts.get(factId); if (!fact) unavailable("integrity.missing_result_fact", factId);
        if (fact.governance.proposal_id !== proposal.id || fact.governance.review_id !== review.id || fact.governance.confirmed_at !== review.reviewed_at) unavailable("integrity.fact_governance_mismatch", factId);
        const terminalReviewId = terminalTargets.get(fact.id); const terminalReview = terminalReviewId ? reviews.get(terminalReviewId) : undefined;
        const expectedExpiresAt = terminalReview?.decision === "approved" && terminalReview.final_operation.operation === "expire_fact" ? terminalReview.final_operation.expires_at : final.suggested_fact.expires_at;
        if (!same({ statement: fact.statement, kind: fact.kind, scope: fact.scope, priority: fact.priority, valid_from: fact.validity.valid_from, expires_at: fact.validity.expires_at, tags: fact.tags }, { ...final.suggested_fact, valid_from: final.suggested_fact.valid_from ?? review.reviewed_at, expires_at: expectedExpiresAt })) unavailable("integrity.final_fact_mismatch", factId);
        if (final.operation === "supersede_fact" && !same(fact.validity.supersedes, final.target_fact_ids)) unavailable("integrity.supersedes_mismatch", factId);
        if (final.operation === "add_fact" && fact.validity.supersedes.length !== 0) unavailable("integrity.add_has_supersedes", factId);
      }
    }
    const targets = final.operation === "add_fact" ? [] : final.target_fact_ids;
    for (const targetId of targets) {
      if (terminalTargets.get(targetId) !== review.id) unavailable("integrity.terminal_review_mismatch", targetId);
      const target = facts.get(targetId); if (!target) unavailable("integrity.missing_target", targetId);
      const expected = final.operation === "supersede_fact" ? "superseded" : "expired";
      if (target.status !== expected) unavailable("integrity.target_status_mismatch", targetId);
      if (final.operation === "expire_fact" && target.validity.expires_at !== final.expires_at) unavailable("integrity.expiry_mismatch", targetId);
    }
  }
  for (const fact of facts.values()) {
    const proposal = proposals.get(fact.governance.proposal_id); const review = reviews.get(fact.governance.review_id);
    if (!proposal || !review || review.decision !== "approved") unavailable("integrity.fact_audit_edge", fact.id);
    if (fact.provenance.source_client !== proposal.source.client) unavailable("integrity.fact_source_mismatch", fact.id);
    if ((fact.status === "superseded" || fact.status === "expired") && !terminalTargets.has(fact.id)) unavailable("integrity.missing_terminal_review", fact.id);
    if (fact.status === "deleted") {
      // Kept readable for compatibility; no v1 operation may create this state.
      if (terminalTargets.has(fact.id)) unavailable("integrity.deleted_created_by_v1", fact.id);
    }
  }
  validateBatchCompleteness(repository, reviews);
  validateRevisionHistory(repository, facts, proposals, reviews);
}

function validateExecutionIdentity(proposal: Proposal, review: Review, operationIds: Set<string>, compensationEdges: Map<string, string>): void {
  const execution = review.execution;
  if (execution === null) { if (review.reviewer.type !== "local_user" || proposal.source.client === "memory_manager") unavailable("integrity.manual_identity", review.id); return; }
  if (review.decision !== "approved" || proposal.confidence !== "high") unavailable("integrity.execution_terminal", review.id);
  if (operationIds.has(execution.operation_id)) unavailable("integrity.operation_id_duplicate", execution.operation_id); operationIds.add(execution.operation_id);
  const input = proposalInput(proposal); const payload = payloadDigest(input); if (payload !== execution.payload_digest) unavailable("integrity.payload_digest", review.id);
  if (operationId("memory_analysis_v1", execution.mode, execution.policy_version, execution.intent, payload, execution.base_knowledge_revision, execution.base_store_revision) !== execution.operation_id) unavailable("integrity.operation_digest", review.id);
  if (execution.mode === "compensation") {
    if (proposal.source.client !== "local_user" || review.reviewer.type !== "local_user" || execution.reverts_review_ids.length === 0) unavailable("integrity.compensation_identity", review.id);
    for (const reverted of execution.reverts_review_ids) { const prior = compensationEdges.get(reverted); if (prior && prior !== execution.batch_id) unavailable("integrity.duplicate_compensation_edge", reverted); compensationEdges.set(reverted, execution.batch_id); }
  } else if (proposal.source.client !== "memory_manager" || review.reviewer.type !== "memory_manager_policy" || execution.reverts_review_ids.length !== 0) unavailable("integrity.automatic_identity", review.id);
}
function validateBatchCompleteness(repository: RepositoryMetadata, reviews: ReadonlyMap<string, Review>): void {
  const batches = new Map<string, Review[]>(); for (const review of reviews.values()) if (review.execution) { const items = batches.get(review.execution.batch_id) ?? []; items.push(review); batches.set(review.execution.batch_id, items); }
  for (const [id, items] of batches) {
    items.sort((a, b) => a.execution!.sequence - b.execution!.sequence); const first = items[0]!.execution!;
    if (items.length !== first.batch_size || items.some((review, index) => review.execution!.sequence !== index + 1 || review.execution!.batch_size !== items.length || review.execution!.base_knowledge_revision !== first.base_knowledge_revision || review.execution!.base_store_revision !== first.base_store_revision || review.execution!.source_digest !== first.source_digest || review.execution!.policy_version !== first.policy_version || review.execution!.mode !== first.mode)) unavailable("integrity.batch_incomplete", id);
    const expected = first.mode === "compensation" ? compensationBatchId(repository.repository_id, [...new Set(items.flatMap((review) => review.execution!.reverts_review_ids))], first.base_knowledge_revision, first.base_store_revision) : batchId(repository.repository_id, first.mode, first.policy_version, first.source_digest, first.base_knowledge_revision, first.base_store_revision);
    if (expected !== id) unavailable("integrity.batch_digest", id);
  }
}
function proposalInput(proposal: Proposal): ProposeInput {
  const common = { operation: proposal.operation, target_fact_ids: [...proposal.target_fact_ids], evidence: proposal.evidence, reasoning: proposal.reasoning, confidence: proposal.confidence };
  return proposal.operation === "expire_fact" ? { ...common, operation: "expire_fact", suggested_expiration: proposal.suggested_expiration } : proposal.operation === "add_fact" ? { ...common, operation: "add_fact", suggested_fact: proposal.suggested_fact } : { ...common, operation: "supersede_fact", suggested_fact: proposal.suggested_fact };
}

interface ReplayState { facts: Map<string, Fact>; proposals: Map<string, Proposal>; reviews: Map<string, Review> }
function validateRevisionHistory(repository: RepositoryMetadata, actualFacts: ReadonlyMap<string, Fact>, allProposals: ReadonlyMap<string, Proposal>, allReviews: ReadonlyMap<string, Review>): void {
  let state: ReplayState = { facts: new Map(), proposals: new Map(), reviews: new Map() };
  const eventTimes = new Set<number>(); for (const proposal of allProposals.values()) eventTimes.add(Date.parse(proposal.created_at)); for (const review of allReviews.values()) eventTimes.add(Date.parse(review.reviewed_at));
  for (const time of [...eventTimes].sort((a, b) => a - b)) {
    const proposalIds = [...allProposals.values()].filter((proposal) => Date.parse(proposal.created_at) === time).map((proposal) => proposal.id);
    const reviewIds = [...allReviews.values()].filter((review) => Date.parse(review.reviewed_at) === time).map((review) => review.id);
    const replayed = replayBatch(repository, allProposals, allReviews, state, proposalIds, reviewIds, new Set());
    if (!replayed) unavailable("integrity.historical_revision_chain"); state = replayed;
  }
  if (!same([...state.facts.values()].sort((a, b) => a.id.localeCompare(b.id, "en")), [...actualFacts.values()].sort((a, b) => a.id.localeCompare(b.id, "en")))) unavailable("integrity.historical_fact_replay");
}
function replayBatch(repository: RepositoryMetadata, allProposals: ReadonlyMap<string, Proposal>, allReviews: ReadonlyMap<string, Review>, state: ReplayState, proposalIds: string[], reviewIds: string[], seen: Set<string>): ReplayState | null {
  if (proposalIds.length === 0 && reviewIds.length === 0) return state;
  const stateKey = `${[...proposalIds].sort().join(",")}|${[...reviewIds].sort().join(",")}|${storeRevision({ repository, facts: state.facts.values(), proposals: state.proposals.values(), reviews: state.reviews.values() })}`;
  if (seen.has(stateKey)) return null; seen.add(stateKey);
  const events = [...reviewIds.map((id) => ({ type: "review" as const, id })), ...proposalIds.map((id) => ({ type: "proposal" as const, id }))].sort((a, b) => a.id.localeCompare(b.id, "en"));
  for (const event of events) {
    if (event.type === "proposal") {
      const next: ReplayState = { facts: new Map(state.facts), proposals: new Map(state.proposals).set(event.id, allProposals.get(event.id)!), reviews: new Map(state.reviews) };
      const result = replayBatch(repository, allProposals, allReviews, next, proposalIds.filter((id) => id !== event.id), reviewIds, seen); if (result) return result;
    } else {
      const review = allReviews.get(event.id)!; if (!state.proposals.has(review.proposal_id)) continue;
      const pre = storeRevision({ repository, facts: state.facts.values(), proposals: state.proposals.values(), reviews: state.reviews.values() }); if (pre !== review.based_on_store_revision) continue;
      const next = applyReplayReview(state, review); if (!next) continue;
      const post = storeRevision({ repository, facts: next.facts.values(), proposals: next.proposals.values(), reviews: next.reviews.values() }); if (review.decision === "approved" && post !== review.resulting_store_revision) continue;
      const result = replayBatch(repository, allProposals, allReviews, next, proposalIds, reviewIds.filter((id) => id !== event.id), seen); if (result) return result;
    }
  }
  return null;
}
function applyReplayReview(state: ReplayState, review: Review): ReplayState | null {
  const facts = new Map(state.facts); const proposal = state.proposals.get(review.proposal_id); if (!proposal) return null;
  if (review.decision === "approved") {
    const final = review.final_operation;
    if (final.operation === "add_fact" || final.operation === "supersede_fact") {
      const factId = final.resulting_fact_ids[0]; const suggested = final.suggested_fact;
      const fact: Fact = { schema_version: 1, id: factId, statement: suggested.statement, kind: suggested.kind, scope: suggested.scope, status: "confirmed", priority: suggested.priority, provenance: { type: proposal.evidence.provenance_type, source_client: proposal.source.client, session_id: proposal.evidence.session_id, reference: proposal.evidence.reference, ...(proposal.evidence.note !== undefined ? { note: proposal.evidence.note } : {}), observed_at: proposal.evidence.observed_at, received_at: proposal.source.received_at }, governance: { proposal_id: proposal.id, review_id: review.id, confirmed_at: review.reviewed_at }, validity: { valid_from: suggested.valid_from ?? review.reviewed_at, expires_at: suggested.expires_at, supersedes: final.operation === "supersede_fact" ? final.target_fact_ids : [] }, tags: suggested.tags }; facts.set(fact.id, fact);
    }
    if (final.operation === "supersede_fact") for (const id of final.target_fact_ids) { const target = facts.get(id); if (!target) return null; facts.set(id, { ...target, status: "superseded" }); }
    if (final.operation === "expire_fact") for (const id of final.target_fact_ids) { const target = facts.get(id); if (!target) return null; facts.set(id, { ...target, status: "expired", validity: { ...target.validity, expires_at: final.expires_at } }); }
  }
  return { facts, proposals: new Map(state.proposals), reviews: new Map(state.reviews).set(review.id, review) };
}
