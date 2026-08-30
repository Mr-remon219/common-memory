import { CoreError } from "../contracts/errors.js";
import { validateRecord } from "../contracts/schema-registry.js";
import type { EditApproveInput, GovernanceInput } from "../contracts/dto.js";
import type { Clock, GovernanceAuthority, IdGenerator } from "../contracts/ports.js";
import { isGovernanceAuthority } from "../contracts/ports.js";
import type { Fact, Proposal, Review, SuggestedFact } from "../contracts/types.js";
import { REVIEW_REVISION_SENTINEL, knowledgeRevision, storeRevision } from "../revision/revisions.js";
import type { LockedRepositorySession } from "../repository/locked-session.js";
import { scanFact, scanReview } from "../safety/scanner.js";
import { factMutation, reviewMutation } from "./mutations.js";
import { projectOperation } from "./project-review.js";

function requireFresh(session: LockedRepositorySession, input: GovernanceInput): Proposal {
  if (input.expected_store_revision !== session.snapshot.store_revision) throw new CoreError("STALE_REVISION", "The repository changed; refresh before reviewing", { expected_store_revision: input.expected_store_revision, current_store_revision: session.snapshot.store_revision });
  const proposal = session.snapshot.proposals.get(input.proposal_id); if (!proposal) throw new CoreError("CONFLICT_DETECTED", "Proposal does not exist", { record_id: input.proposal_id });
  if ([...session.snapshot.reviews.values()].some((review) => review.proposal_id === proposal.id)) throw new CoreError("CONFLICT_DETECTED", "Proposal already has a terminal review", { record_id: proposal.id });
  return proposal;
}
function requireAuthority(authority: GovernanceAuthority): void { if (!isGovernanceAuthority(authority)) throw new CoreError("PERMISSION_DENIED", "A trusted local governance authority is required"); }
function factFrom(suggested: SuggestedFact, proposal: Proposal, reviewId: string, factId: string, reviewedAt: string, supersedes: string[]): Fact {
  const validFrom = suggested.valid_from ?? reviewedAt;
  const fact: Fact = { schema_version: 1, id: factId, statement: suggested.statement, kind: suggested.kind, scope: suggested.scope, status: "confirmed", priority: suggested.priority, provenance: { type: proposal.evidence.provenance_type, source_client: proposal.source.client, session_id: proposal.evidence.session_id, reference: proposal.evidence.reference, ...(proposal.evidence.note !== undefined ? { note: proposal.evidence.note } : {}), observed_at: proposal.evidence.observed_at, received_at: proposal.source.received_at }, governance: { proposal_id: proposal.id, review_id: reviewId, confirmed_at: reviewedAt }, validity: { valid_from: validFrom, expires_at: suggested.expires_at, supersedes }, tags: suggested.tags };
  validateRecord("fact", fact); scanFact(fact); return fact;
}
export function approveProposal(session: LockedRepositorySession, input: GovernanceInput | EditApproveInput, authority: GovernanceAuthority, clock: Clock, ids: IdGenerator, edits?: EditApproveInput["edits"]) {
  requireAuthority(authority); const proposal = requireFresh(session, input); const reviewedAt = clock.now().toISOString(); const projected = projectOperation(proposal, edits);
  const targets = projected.operation === "add_fact" ? [] : projected.target_fact_ids.map((id) => { const fact = session.snapshot.facts.get(id); if (!fact || fact.status !== "confirmed") throw new CoreError("CONFLICT_DETECTED", "Every governance target must exist and be confirmed", { record_id: id }); return fact; });
  if (new Set(targets.map((fact) => fact.id)).size !== targets.length || (projected.operation !== "add_fact" && targets.length === 0)) throw new CoreError("VALIDATION_FAILED", "Governance targets must be a non-empty set");
  if (projected.operation === "supersede_fact" && projected.suggested_fact.valid_from !== null && Date.parse(projected.suggested_fact.valid_from) > Date.parse(reviewedAt)) throw new CoreError("VALIDATION_FAILED", "A superseding fact cannot begin after review", { reason: "FUTURE_SUPERSEDE" });
  if (projected.operation === "expire_fact") for (const target of targets) if (Date.parse(projected.expires_at) > Date.parse(reviewedAt) || Date.parse(projected.expires_at) <= Date.parse(target.validity.valid_from)) throw new CoreError("VALIDATION_FAILED", "Expiration time is outside the allowed interval", { reason: "INVALID_EXPIRATION" });
  const reviewId = ids.next("review"); if (session.snapshot.reviews.has(reviewId)) throw new CoreError("CONFLICT_DETECTED", "Generated review ID already exists");
  const facts = new Map(session.snapshot.facts); const resulting: string[] = [];
  if (projected.operation === "add_fact" || projected.operation === "supersede_fact") {
    const factId = ids.next("fact"); if (session.snapshot.facts.has(factId)) throw new CoreError("CONFLICT_DETECTED", "Generated fact ID already exists"); resulting.push(factId); const fact = factFrom(projected.suggested_fact, proposal, reviewId, factId, reviewedAt, projected.operation === "supersede_fact" ? projected.target_fact_ids : []); facts.set(fact.id, fact);
  }
  if (projected.operation === "supersede_fact") for (const target of targets) facts.set(target.id, { ...target, status: "superseded" });
  if (projected.operation === "expire_fact") for (const target of targets) facts.set(target.id, { ...target, status: "expired", validity: { ...target.validity, expires_at: projected.expires_at } });
  const final = projected.operation === "add_fact" ? { operation: "add_fact" as const, suggested_fact: { ...projected.suggested_fact, valid_from: projected.suggested_fact.valid_from ?? reviewedAt }, resulting_fact_ids: resulting as [string] }
    : projected.operation === "supersede_fact" ? { operation: "supersede_fact" as const, target_fact_ids: projected.target_fact_ids, suggested_fact: { ...projected.suggested_fact, valid_from: projected.suggested_fact.valid_from ?? reviewedAt }, resulting_fact_ids: resulting as [string] }
    : { operation: "expire_fact" as const, target_fact_ids: projected.target_fact_ids, expires_at: projected.expires_at, reason: projected.reason, resulting_fact_ids: [] as [] };
  let review: Review = { schema_version: 1, id: reviewId, proposal_id: proposal.id, decision: "approved", reviewed_at: reviewedAt, reviewer: { type: "local_user" }, note: input.note ?? null, execution: null, final_operation: final, based_on_store_revision: session.snapshot.store_revision, resulting_store_revision: REVIEW_REVISION_SENTINEL };
  validateRecord("review", review); scanReview(review);
  const reviews = new Map(session.snapshot.reviews).set(review.id, review); const nextStore = storeRevision({ repository: session.snapshot.repository, facts: facts.values(), proposals: session.snapshot.proposals.values(), reviews: reviews.values() });
  review = { ...review, resulting_store_revision: nextStore }; reviews.set(review.id, review); validateRecord("review", review);
  const mutations = [...facts.values()].filter((fact) => session.snapshot.facts.get(fact.id) !== fact).map((fact) => factMutation(session.layout, fact)); mutations.push(reviewMutation(session.layout, review));
  const nextKnowledge = knowledgeRevision(facts.values()); session.apply(mutations, { knowledge: nextKnowledge, store: nextStore }); return { review, resulting_fact_ids: resulting, knowledge_revision: nextKnowledge, store_revision: nextStore };
}
export function rejectProposal(session: LockedRepositorySession, input: GovernanceInput, authority: GovernanceAuthority, clock: Clock, ids: IdGenerator) {
  requireAuthority(authority); const proposal = requireFresh(session, input); const reviewId = ids.next("review"); if (session.snapshot.reviews.has(reviewId)) throw new CoreError("CONFLICT_DETECTED", "Generated review ID already exists"); const review: Review = { schema_version: 1, id: reviewId, proposal_id: proposal.id, decision: "rejected", reviewed_at: clock.now().toISOString(), reviewer: { type: "local_user" }, note: input.note ?? null, execution: null, based_on_store_revision: session.snapshot.store_revision };
  validateRecord("review", review); scanReview(review); const reviews = new Map(session.snapshot.reviews).set(review.id, review); const nextStore = storeRevision({ repository: session.snapshot.repository, facts: session.snapshot.facts.values(), proposals: session.snapshot.proposals.values(), reviews: reviews.values() });
  session.apply([reviewMutation(session.layout, review)], { knowledge: session.snapshot.knowledge_revision, store: nextStore }); return { review, knowledge_revision: session.snapshot.knowledge_revision, store_revision: nextStore };
}
