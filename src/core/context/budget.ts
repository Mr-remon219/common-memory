import { CoreError } from "../contracts/errors.js";
export const CONTEXT_STRUCTURE_OVERHEAD_BYTES = 96;
// Contract: canonical compact DTO UTF-8 bytes plus fixed structure overhead is a
// deterministic, model-independent conservative upper-bound unit, not an exact tokenizer count.
export function conservativeTokenUpperBound(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8") + CONTEXT_STRUCTURE_OVERHEAD_BYTES; }
export function requireCoreBudget(value: unknown, maxTokens: number): void {
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new CoreError("VALIDATION_FAILED", "Invalid context budget", { reason: "INVALID_BUDGET" });
  if (conservativeTokenUpperBound(value) > maxTokens) throw new CoreError("VALIDATION_FAILED", "Core facts exceed the context budget", { reason: "CORE_BUDGET_EXCEEDED" });
}
