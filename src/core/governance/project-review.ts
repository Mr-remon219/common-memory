import { CoreError } from "../contracts/errors.js";
import type { EditApproveInput } from "../contracts/dto.js";
import type { Proposal, SuggestedFact } from "../contracts/types.js";

export type ProjectedOperation =
  | { operation: "add_fact"; target_fact_ids: []; suggested_fact: SuggestedFact }
  | { operation: "supersede_fact"; target_fact_ids: string[]; suggested_fact: SuggestedFact }
  | { operation: "expire_fact"; target_fact_ids: string[]; expires_at: string; reason: string };
const SUGGESTED_KEYS = ["statement", "kind", "scope", "priority", "valid_from", "expires_at", "tags"] as const;
function assertEditKeys(edits: EditApproveInput["edits"] | undefined, allowed: readonly string[]): void { if (edits && Object.keys(edits).some((key) => !allowed.includes(key))) invalid(); }
export function projectOperation(proposal: Proposal, edits?: EditApproveInput["edits"]): ProjectedOperation {
  if (proposal.operation === "expire_fact") {
    assertEditKeys(edits, ["target_fact_ids", "expires_at", "reason"]); return { operation: "expire_fact", target_fact_ids: edits?.target_fact_ids ?? proposal.target_fact_ids, expires_at: edits?.expires_at ?? proposal.suggested_expiration.expires_at, reason: edits?.reason ?? proposal.suggested_expiration.reason };
  }
  assertEditKeys(edits, proposal.operation === "add_fact" ? SUGGESTED_KEYS : [...SUGGESTED_KEYS, "target_fact_ids"]);
  const suggested = { ...proposal.suggested_fact };
  for (const key of SUGGESTED_KEYS) if (edits && edits[key] !== undefined) Object.assign(suggested, { [key]: edits[key] });
  return proposal.operation === "add_fact" ? { operation: "add_fact", target_fact_ids: [], suggested_fact: suggested } : { operation: "supersede_fact", target_fact_ids: edits?.target_fact_ids ?? proposal.target_fact_ids, suggested_fact: suggested };
}
function invalid(): never { throw new CoreError("VALIDATION_FAILED", "Edit is outside the approved field matrix", { reason: "EDIT_FIELD_NOT_ALLOWED" }); }
