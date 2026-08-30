import { CoreError } from "../contracts/errors.js";
import type { GovernanceLogInput, GovernanceLogPage } from "../contracts/dto.js";
import type { RepositorySnapshot } from "../contracts/types.js";
export function governanceLog(snapshot: RepositorySnapshot, input: GovernanceLogInput = {}): GovernanceLogPage {
  const limit = input.limit ?? 50; if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CoreError("VALIDATION_FAILED", "Governance log limit must be between 1 and 100");
  let after = "";
  if (input.cursor) { let parsed: unknown; try { parsed = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")); } catch { throw new CoreError("VALIDATION_FAILED", "Invalid governance cursor"); } const cursor = parsed as { store_revision?: string; after?: string }; if (cursor.store_revision !== snapshot.store_revision || typeof cursor.after !== "string") throw new CoreError("STALE_REVISION", "Governance cursor belongs to another store revision"); after = cursor.after; }
  const reviewsByProposal = new Map([...snapshot.reviews.values()].map((review) => [review.proposal_id, review]));
  const proposals = [...snapshot.proposals.values()].filter((proposal) => compareUtf8(proposal.id, after) > 0).filter((proposal) => !input.batch_id || reviewsByProposal.get(proposal.id)?.execution?.batch_id === input.batch_id).sort((a, b) => compareUtf8(a.id, b.id));
  const selected = proposals.slice(0, limit); const items = selected.map((proposal) => ({ proposal, review: reviewsByProposal.get(proposal.id) ?? null }));
  const next = proposals.length > selected.length ? Buffer.from(JSON.stringify({ store_revision: snapshot.store_revision, after: selected.at(-1)!.id }), "utf8").toString("base64url") : null;
  return { items, next_cursor: next, store_revision: snapshot.store_revision };
}
function compareUtf8(a: string, b: string): number { return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")); }
