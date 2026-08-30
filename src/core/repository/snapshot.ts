import type { Fact, Proposal, RepositoryMetadata, RepositorySnapshot, Review, Revision } from "../contracts/types.js";
export function immutableSnapshot(repository: RepositoryMetadata, facts: Map<string, Fact>, proposals: Map<string, Proposal>, reviews: Map<string, Review>, knowledge_revision: Revision, store_revision: Revision, index_revision: Revision | null): RepositorySnapshot {
  return Object.freeze({ repository: Object.freeze(repository), facts, proposals, reviews, knowledge_revision, store_revision, index_revision });
}
