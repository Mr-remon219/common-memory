import type { RepositorySnapshot } from "../contracts/types.js";
export interface RepositoryDiagnostics { valid: true; facts: number; confirmed: number; pending_proposals: number; reviews: number; knowledge_revision: string; store_revision: string; index_revision: string | null }
export function diagnostics(snapshot: RepositorySnapshot): RepositoryDiagnostics {
  const reviewed = new Set([...snapshot.reviews.values()].map((review) => review.proposal_id));
  return { valid: true, facts: snapshot.facts.size, confirmed: [...snapshot.facts.values()].filter((fact) => fact.status === "confirmed").length, pending_proposals: [...snapshot.proposals.values()].filter((proposal) => !reviewed.has(proposal.id)).length, reviews: snapshot.reviews.size, knowledge_revision: snapshot.knowledge_revision, store_revision: snapshot.store_revision, index_revision: snapshot.index_revision };
}
