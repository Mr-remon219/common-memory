import type { FaultInjector, IdGenerator } from "../contracts/ports.js";
import type { RepositorySnapshot, Revision } from "../contracts/types.js";
import { CoreError } from "../contracts/errors.js";
import { RepositoryLock } from "../transaction/lock.js";
import { recoverAll } from "../transaction/recovery.js";
import { applyTransaction, type Mutation } from "../transaction/transaction.js";
import { loadRepository } from "./loader.js";
import type { RepositoryLayout } from "./layout.js";
import { authorityRelativePath } from "./path-safety.js";
import { parseYamlStrict } from "../serialization/parse.js";
import type { Fact, Proposal, Review } from "../contracts/types.js";
import { scanFact, scanProposal, scanReview } from "../safety/scanner.js";
import { validateIntegrity } from "./integrity.js";
import { knowledgeRevision, storeRevision } from "../revision/revisions.js";

export class LockedRepositorySession implements Disposable {
  readonly #lock: RepositoryLock;
  readonly layout: RepositoryLayout;
  readonly #ids: IdGenerator;
  readonly faults: FaultInjector;
  snapshot: RepositorySnapshot;
  constructor(layout: RepositoryLayout, ids: IdGenerator, faults: FaultInjector, timeoutMs = 2_000) {
    this.layout = layout; this.#ids = ids; this.faults = faults; this.#lock = new RepositoryLock(layout.lockDatabase, timeoutMs, faults, layout.dataRoot);
    try { recoverAll(layout, faults); this.snapshot = loadRepository(layout); } catch (error) { try { this.#lock.close(); } catch { /* Preserve the operation failure. */ } throw error; }
  }
  apply(mutations: readonly Mutation[], expectedPost: { knowledge: Revision; store: Revision }): RepositorySnapshot {
    this.#validatePostImage(mutations, expectedPost);
    applyTransaction(this.layout, mutations, expectedPost, this.#ids, this.faults, () => {
      const loaded = loadRepository(this.layout);
      if (loaded.knowledge_revision !== expectedPost.knowledge || loaded.store_revision !== expectedPost.store) throw new CoreError("STORE_UNAVAILABLE", "Transaction post-image revision mismatch", { rule_id: "transaction.post_revision_mismatch" });
    });
    this.snapshot = loadRepository(this.layout); return this.snapshot;
  }
  #validatePostImage(mutations: readonly Mutation[], expectedPost: { knowledge: Revision; store: Revision }): void {
    const facts = new Map(this.snapshot.facts); const proposals = new Map(this.snapshot.proposals); const reviews = new Map(this.snapshot.reviews);
    for (const mutation of mutations) {
      const path = authorityRelativePath(this.layout, mutation.path);
      if (path.startsWith("memory/facts/")) { const value = parseYamlStrict(mutation.bytes, "fact") as Fact; scanFact(value); facts.set(value.id, value); }
      else if (path.startsWith("memory/proposals/")) { const value = parseYamlStrict(mutation.bytes, "proposal") as Proposal; scanProposal(value); proposals.set(value.id, value); }
      else { const value = parseYamlStrict(mutation.bytes, "review") as Review; scanReview(value); reviews.set(value.id, value); }
    }
    validateIntegrity(this.snapshot.repository, facts, proposals, reviews);
    if (knowledgeRevision(facts.values()) !== expectedPost.knowledge || storeRevision({ repository: this.snapshot.repository, facts: facts.values(), proposals: proposals.values(), reviews: reviews.values() }) !== expectedPost.store) throw new CoreError("STORE_UNAVAILABLE", "Candidate post-image revision mismatch", { rule_id: "transaction.candidate_revision_mismatch" });
  }
  reload(): RepositorySnapshot { this.snapshot = loadRepository(this.layout); return this.snapshot; }
  close(): void { this.#lock.close(); }
  [Symbol.dispose](): void { this.close(); }
}
