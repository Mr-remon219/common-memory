import type { Proposal, RepositorySnapshot } from "../contracts/types.js";
import { canonicalScope } from "../query/scope.js";
export interface ProposalHint { type: "duplicate" | "conflict"; record_id: string }
export function proposalHints(snapshot: RepositorySnapshot, candidate: Proposal): ProposalHint[] {
  const hints: ProposalHint[] = [];
  if (candidate.operation !== "expire_fact") {
    const statement = candidate.suggested_fact.statement.trim(); const scope = canonicalScope(candidate.suggested_fact.scope);
    for (const fact of snapshot.facts.values()) if (canonicalScope(fact.scope) === scope && fact.statement.trim() === statement) hints.push({ type: "duplicate", record_id: fact.id });
    for (const proposal of snapshot.proposals.values()) if (proposal.operation !== "expire_fact" && canonicalScope(proposal.suggested_fact.scope) === scope && proposal.suggested_fact.statement.trim() === statement && ![...snapshot.reviews.values()].some((review) => review.proposal_id === proposal.id)) hints.push({ type: "duplicate", record_id: proposal.id });
  }
  if (candidate.operation !== "add_fact") for (const target of candidate.target_fact_ids) if (![...snapshot.facts.keys()].includes(target)) hints.push({ type: "conflict", record_id: target });
  return hints.sort((a, b) => a.type.localeCompare(b.type) || a.record_id.localeCompare(b.record_id, "en"));
}
