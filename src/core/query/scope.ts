import { CoreError } from "../contracts/errors.js";
import type { Scope } from "../contracts/types.js";
const LOCAL_SCOPE = /^(project|agent|device):([^:\s]+)$/u;
export function canonicalScope(scope: Scope): string { return scope.type === "global" ? "global" : `${scope.type}:${scope.id}`; }
export function parseScopes(input: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(input) || input.length === 0) invalid();
  const result = new Set<string>();
  for (const value of input) {
    if (value !== "global" && !LOCAL_SCOPE.test(value)) invalid();
    if (result.has(value)) invalid(); result.add(value);
  }
  return result;
}
export function scopeMatches(scope: Scope, requested: ReadonlySet<string>): boolean { return requested.has(canonicalScope(scope)); }
function invalid(): never { throw new CoreError("VALIDATION_FAILED", "Scopes must be a non-empty exact set", { violations: [{ field_path: "/scopes", rule_id: "scope.invalid" }] }); }
