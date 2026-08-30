import { CoreError } from "../contracts/errors.js";
import type { GetInput } from "../contracts/dto.js";
import { FACT_KINDS, FACT_STATUSES, type Fact, type RepositorySnapshot } from "../contracts/types.js";
import { parseScopes, scopeMatches } from "./scope.js";
import { intersectsTimeRange, isCurrentlyValid } from "./validity.js";
import { parseQueryTime } from "./time.js";

export function eligibleFacts(snapshot: RepositorySnapshot, input: GetInput, capturedNow: string): Fact[] {
  const scopes = parseScopes(input.scopes); const validAt = parseQueryTime(input.valid_at ?? capturedNow, "/valid_at");
  if (input.ids !== undefined && (!Array.isArray(input.ids) || new Set(input.ids).size !== input.ids.length || input.ids.some((id) => !/^fact\.[A-Za-z0-9_-]{8,128}$/.test(id)))) invalid("ids.invalid");
  if (input.kinds !== undefined && (!Array.isArray(input.kinds) || input.kinds.some((kind) => !FACT_KINDS.includes(kind)))) invalid("kinds.invalid");
  if (input.statuses !== undefined && (!Array.isArray(input.statuses) || input.statuses.some((status) => !FACT_STATUSES.includes(status)))) invalid("statuses.invalid");
  if (input.time_range) { if (input.time_range.from !== null) parseQueryTime(input.time_range.from, "/time_range/from"); if (input.time_range.to !== null) parseQueryTime(input.time_range.to, "/time_range/to"); if (input.time_range.from && input.time_range.to && Date.parse(input.time_range.from) >= Date.parse(input.time_range.to)) invalid("time_range.invalid"); }
  const includeHistory = input.include_history ?? false;
  if (!includeHistory && input.statuses?.some((status) => status !== "confirmed")) invalid("history.requires_opt_in");
  const ids = input.ids ? new Set(input.ids) : null; const kinds = input.kinds ? new Set(input.kinds) : null; const statuses = input.statuses ? new Set(input.statuses) : null;
  return [...snapshot.facts.values()].filter((fact) => {
    if (ids && !ids.has(fact.id) || kinds && !kinds.has(fact.kind) || !scopeMatches(fact.scope, scopes) || !intersectsTimeRange(fact, input.time_range)) return false;
    if (!includeHistory) return fact.priority !== "archive" && isCurrentlyValid(fact, validAt);
    return statuses ? statuses.has(fact.status) : true;
  }).sort((a, b) => a.id.localeCompare(b.id, "en"));
}
function invalid(reason: string): never { throw new CoreError("VALIDATION_FAILED", "Invalid query", { reason }); }
