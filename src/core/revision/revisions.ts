import type { Fact, Proposal, RepositoryMetadata, Review, Revision } from "../contracts/types.js";
import { canonicalYamlBytes } from "../serialization/canonical-yaml.js";
import { SCHEMA_FILES, schemaBytes } from "../contracts/schema-registry.js";
import { framedRevision } from "./hash.js";

export const REVIEW_REVISION_SENTINEL = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as Revision;
export interface RevisionImage { repository: RepositoryMetadata; facts: Iterable<Fact>; proposals: Iterable<Proposal>; reviews: Iterable<Review> }
export function knowledgeRevision(facts: Iterable<Fact>): Revision {
  return framedRevision("knowledge", [...facts].map((fact) => ({ path: `memory/facts/${fact.id}.yaml`, bytes: canonicalYamlBytes("fact", fact) })));
}
export function storeRevision(image: RevisionImage): Revision {
  const files: Array<{ path: string; bytes: Uint8Array }> = [{ path: "repository.yaml", bytes: canonicalYamlBytes("repository", image.repository) }];
  for (const name of SCHEMA_FILES) files.push({ path: `schema/${name}`, bytes: schemaBytes(name) });
  for (const fact of image.facts) files.push({ path: `memory/facts/${fact.id}.yaml`, bytes: canonicalYamlBytes("fact", fact) });
  for (const proposal of image.proposals) files.push({ path: `memory/proposals/${proposal.id}.yaml`, bytes: canonicalYamlBytes("proposal", proposal) });
  for (const review of image.reviews) {
    const hashed = review.decision === "approved" ? { ...review, resulting_store_revision: REVIEW_REVISION_SENTINEL } : review;
    files.push({ path: `memory/reviews/${review.id}.yaml`, bytes: canonicalYamlBytes("review", hashed) });
  }
  return framedRevision("store", files);
}
