import type { Fact } from "../contracts/types.js";
import { scopeMatches } from "../query/scope.js";

export function calculateValidUntil(facts: Iterable<Fact>, scopes: ReadonlySet<string>, evaluatedAt: string): string | null {
  const now = Date.parse(evaluatedAt); let earliest = Number.POSITIVE_INFINITY;
  for (const fact of facts) {
    if (!scopeMatches(fact.scope, scopes)) continue;
    for (const boundary of [fact.validity.valid_from, fact.validity.expires_at]) {
      if (boundary !== null) { const time = Date.parse(boundary); if (time > now && time < earliest) earliest = time; }
    }
  }
  return Number.isFinite(earliest) ? new Date(earliest).toISOString() : null;
}
