import { CoreError } from "../contracts/errors.js";
import type { ProposeInput } from "../contracts/dto.js";
import type { Clock, IdGenerator, TrustedContributor } from "../contracts/ports.js";
import { isTrustedContributor } from "../contracts/ports.js";
import type { Proposal } from "../contracts/types.js";
import { validateRecord } from "../contracts/schema-registry.js";
import { scanProposal } from "../safety/scanner.js";

const COMMON_KEYS = ["operation", "target_fact_ids", "evidence", "reasoning", "confidence"] as const;
function exactKeys(input: Record<string, unknown>, operationField: "suggested_fact" | "suggested_expiration"): boolean {
  const expected = new Set<string>([...COMMON_KEYS, operationField]); return Object.keys(input).length === expected.size && Object.keys(input).every((key) => expected.has(key));
}
export function createProposal(input: ProposeInput, contributor: TrustedContributor, clock: Clock, ids: IdGenerator): Proposal {
  const candidate = validateProposeInput(input, contributor);
  scanProposal(candidate);
  const receivedAt = clock.now().toISOString();
  const proposal = { ...candidate, id: ids.next("proposal"), source: { client: contributor.client, received_at: receivedAt }, created_at: receivedAt } as Proposal;
  validateRecord("proposal", proposal); return proposal;
}
function validateProposeInput(input: ProposeInput, contributor: TrustedContributor): Proposal {
  if (!isTrustedContributor(contributor)) throw new CoreError("PERMISSION_DENIED", "A trusted contributor capability is required");
  if (!input || typeof input !== "object" || !new Set(["local_user", "local_user", "memory_manager"]).has(contributor.client)) invalid("proposal.invalid_input");
  const raw = input as unknown as Record<string, unknown>;
  if (!Array.isArray(input.target_fact_ids) || !input.evidence || typeof input.evidence !== "object" || input.evidence.session_id !== contributor.sessionId) invalid(input.evidence?.session_id !== contributor.sessionId ? "proposal.session_mismatch" : "proposal.invalid_input");
  const base = { schema_version: 1 as const, id: "proposal.00000000", target_fact_ids: input.target_fact_ids, evidence: input.evidence, reasoning: input.reasoning, confidence: input.confidence, source: { client: contributor.client, received_at: "2000-01-01T00:00:00.000Z" }, created_at: "2000-01-01T00:00:00.000Z" };
  let candidate: Proposal;
  if (input.operation === "add_fact") {
    if (!exactKeys(raw, "suggested_fact") || input.target_fact_ids.length !== 0 || input.suggested_fact === undefined) invalid("proposal.add_shape");
    candidate = { ...base, operation: "add_fact", target_fact_ids: [] as [], suggested_fact: input.suggested_fact };
  } else if (input.operation === "supersede_fact") {
    if (!exactKeys(raw, "suggested_fact") || input.target_fact_ids.length === 0 || input.suggested_fact === undefined) invalid("proposal.supersede_shape");
    candidate = { ...base, operation: "supersede_fact", suggested_fact: input.suggested_fact };
  } else if (input.operation === "expire_fact") {
    if (!exactKeys(raw, "suggested_expiration") || input.target_fact_ids.length === 0 || input.suggested_expiration === undefined) invalid("proposal.expire_shape");
    candidate = { ...base, operation: "expire_fact", suggested_expiration: input.suggested_expiration };
  } else invalid("proposal.invalid_operation");
  validateRecord("proposal", candidate); return candidate;
}
function invalid(reason: string): never { throw new CoreError("VALIDATION_FAILED", "Invalid proposal", { reason }); }
