import { canonicalYamlBytes } from "../serialization/canonical-yaml.js";
import type { Fact, Proposal, Review } from "../contracts/types.js";
import type { RepositoryLayout } from "../repository/layout.js";
import type { Mutation } from "../transaction/transaction.js";
export function proposalMutation(layout: RepositoryLayout, proposal: Proposal): Mutation { return { path: layout.proposalPath(proposal.id), bytes: canonicalYamlBytes("proposal", proposal) }; }
export function factMutation(layout: RepositoryLayout, fact: Fact): Mutation { return { path: layout.factPath(fact.id), bytes: canonicalYamlBytes("fact", fact) }; }
export function reviewMutation(layout: RepositoryLayout, review: Review): Mutation { return { path: layout.reviewPath(review.id), bytes: canonicalYamlBytes("review", review) }; }
