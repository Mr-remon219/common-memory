import { CoreError } from "../contracts/errors.js";
import { ALWAYS_REJECT_RULES } from "./rules.js";
import { irreversibleFingerprint } from "./redaction.js";

export interface SafetyField { path: string; value: string }
export interface SafetyViolation { rule_id: string; field_path: string; fingerprint: string }
export function scanFields(fields: readonly SafetyField[], _agentInference = false): void {
  const violations: SafetyViolation[] = [];
  for (const field of fields) {
    // A complete UUID is not a payment card. Exclude only its complete token
    // for this one numeric rule; credential/identity rules still see all input.
    for (const rule of ALWAYS_REJECT_RULES) if (rule.pattern.test(rule.id === 'payment.card'
      ? field.value.replace(/(?<![A-Za-z0-9_])[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?![A-Za-z0-9_])/giu, '[uuid]')
      : field.value)) violations.push({ rule_id: rule.id, field_path: field.path, fingerprint: irreversibleFingerprint(field.value) });
  }
  if (violations.length) throw new CoreError("SENSITIVE_CONTENT_REJECTED", "Content policy rejected the candidate", { violations });
}
