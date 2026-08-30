import { CoreError } from "../contracts/errors.js";
import type { Fact, Proposal, Review } from "../contracts/types.js";
import { ALWAYS_REJECT_RULES, INFERENCE_REJECT_RULES } from "./rules.js";
import { irreversibleFingerprint } from "./redaction.js";

export interface SafetyField { path: string; value: string }
export interface SafetyViolation { rule_id: string; field_path: string; fingerprint: string }
export function scanFields(fields: readonly SafetyField[], agentInference = false): void {
  const violations: SafetyViolation[] = [];
  for (const field of fields) {
    for (const rule of ALWAYS_REJECT_RULES) if (rule.pattern.test(field.value)) violations.push({ rule_id: rule.id, field_path: field.path, fingerprint: irreversibleFingerprint(field.value) });
    if (agentInference) for (const rule of INFERENCE_REJECT_RULES) if (rule.pattern.test(field.value)) violations.push({ rule_id: rule.id, field_path: field.path, fingerprint: irreversibleFingerprint(field.value) });
  }
  if (violations.length) throw new CoreError("SENSITIVE_CONTENT_REJECTED", "Content policy rejected the candidate", { violations });
}
function text(path: string, value: string | null | undefined): SafetyField[] { return value === null || value === undefined ? [] : [{ path, value }]; }
function suggested(prefix: string, value: { statement: string; tags: string[]; scope: { id: string | null } }): SafetyField[] { return [...text(`${prefix}/statement`, value.statement), ...text(`${prefix}/scope/id`, value.scope.id), ...value.tags.map((tag, index) => ({ path: `${prefix}/tags/${index}`, value: tag }))]; }
export function scanProposal(proposal: Proposal): void {
  const fields = [
    ...text("/reasoning", proposal.reasoning), ...text("/evidence/session_id", proposal.evidence.session_id), ...text("/evidence/reference", proposal.evidence.reference), ...text("/evidence/note", proposal.evidence.note),
    ...(proposal.operation === "expire_fact" ? text("/suggested_expiration/reason", proposal.suggested_expiration.reason) : suggested("/suggested_fact", proposal.suggested_fact))
  ];
  scanFields(fields, proposal.evidence.provenance_type === "agent_observation");
}
export function scanFact(fact: Fact): void { scanFields([...text("/statement", fact.statement), ...text("/scope/id", fact.scope.id), ...fact.tags.map((value, index) => ({ path: `/tags/${index}`, value })), ...text("/provenance/session_id", fact.provenance.session_id), ...text("/provenance/reference", fact.provenance.reference), ...text("/provenance/note", fact.provenance.note)], fact.provenance.type === "agent_observation"); }
export function scanReview(review: Review): void {
  const fields = [...text("/note", review.note)];
  if (review.decision === "approved") {
    const operation = review.final_operation;
    if (operation.operation === "expire_fact") fields.push(...text("/final_operation/reason", operation.reason));
    else fields.push(...suggested("/final_operation/suggested_fact", operation.suggested_fact));
  }
  scanFields(fields);
}
