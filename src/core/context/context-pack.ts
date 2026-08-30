import type { ContextPackInput, SearchResult } from "../contracts/dto.js";
import type { Fact, RepositorySnapshot } from "../contracts/types.js";
import { calculateValidUntil } from "../revision/valid-until.js";
import { parseScopes } from "../query/scope.js";
import { eligibleFacts } from "../query/read.js";
import { requireCoreBudget, conservativeTokenUpperBound } from "./budget.js";
import { parseQueryTime } from "../query/time.js";

function item(fact: Fact, reason: string, provenanceDetails = true) { const source = { type: fact.provenance.type, source_client: fact.provenance.source_client, reference: fact.provenance.reference }; return { id: fact.id, statement: fact.statement, kind: fact.kind, scope: fact.scope, validity: fact.validity, source, ...(provenanceDetails ? { provenance_details: { session_id: fact.provenance.session_id, note: fact.provenance.note ?? null, observed_at: fact.provenance.observed_at, received_at: fact.provenance.received_at } } : {}), reason }; }
export function buildContextPack(snapshot: RepositorySnapshot, input: ContextPackInput, capturedNow: string, searchResults: SearchResult[], historicalResults: SearchResult[] = [], degraded = false) {
  const evaluatedAt = input.valid_at === undefined ? capturedNow : parseQueryTime(input.valid_at, "/valid_at"); const scopes = parseScopes(input.scopes);
  const current = eligibleFacts(snapshot, { scopes: input.scopes, valid_at: evaluatedAt }, capturedNow);
  const coreFacts = current.filter((fact) => fact.priority === "core");
  const boundaries = coreFacts.filter((fact) => fact.kind === "constraint").map((fact) => item(fact, "deterministic-core-constraint", false));
  const core = coreFacts.filter((fact) => fact.kind !== "constraint").map((fact) => item(fact, "deterministic-core", false));
  const minimal = { knowledge_revision: snapshot.knowledge_revision, evaluated_at: evaluatedAt, valid_until: calculateValidUntil(snapshot.facts.values(), scopes, evaluatedAt), core, boundaries, relevant: [], historical: [], warnings: degraded ? ["INDEX_OUTDATED"] : [], degraded };
  requireCoreBudget(minimal, input.max_tokens);
  if (degraded) return minimal;
  const coreIds = new Set(coreFacts.map((fact) => fact.id)); const relevant: ReturnType<typeof item>[] = [];
  for (const result of searchResults) {
    if (coreIds.has(result.fact.id)) continue;
    const candidate = item(result.fact, result.match_reasons.join("+"), true); const next = { ...minimal, relevant: [...relevant, candidate] };
    if (conservativeTokenUpperBound(next) <= input.max_tokens) relevant.push(candidate); else {
      const compact = item(result.fact, result.match_reasons.join("+"), false); if (conservativeTokenUpperBound({ ...minimal, relevant: [...relevant, compact] }) <= input.max_tokens) relevant.push(compact);
    }
  }
  const selectedIds = new Set([...coreIds, ...relevant.map((entry) => entry.id)]);
  const historical = input.include_history && input.time_range ? historicalResults.filter((result) => !selectedIds.has(result.fact.id) && (result.fact.status !== "confirmed" || result.fact.priority === "archive" || result.fact.kind === "event")).map((result) => item(result.fact, `explicit-history-query+${result.match_reasons.join("+")}`, false)) : [];
  const acceptedHistory: typeof historical = []; for (const candidate of historical) if (conservativeTokenUpperBound({ ...minimal, relevant, historical: [...acceptedHistory, candidate] }) <= input.max_tokens) acceptedHistory.push(candidate);
  return { ...minimal, relevant, historical: acceptedHistory };
}
