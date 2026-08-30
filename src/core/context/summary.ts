import { CoreError } from "../contracts/errors.js";
import type { SummaryInput } from "../contracts/dto.js";
import type { Fact, RepositorySnapshot } from "../contracts/types.js";
import { calculateValidUntil } from "../revision/valid-until.js";
import { parseScopes } from "../query/scope.js";
import { eligibleFacts } from "../query/read.js";
import { conservativeTokenUpperBound } from "./budget.js";
import { parseQueryTime } from "../query/time.js";

const kindOrder = ["constraint", "identity", "goal", "preference", "environment", "relationship", "decision", "event"];
export function buildSummary(snapshot: RepositorySnapshot, input: SummaryInput, capturedNow: string) {
  const evaluatedAt = input.valid_at === undefined ? capturedNow : parseQueryTime(input.valid_at, "/valid_at"); const scopes = parseScopes(input.scopes);
  if (input.max_tokens !== undefined && (!Number.isInteger(input.max_tokens) || input.max_tokens <= 0)) throw new CoreError("VALIDATION_FAILED", "Invalid summary budget", { reason: "INVALID_BUDGET" });
  const facts = eligibleFacts(snapshot, { scopes: input.scopes, valid_at: evaluatedAt }, capturedNow).filter((fact) => fact.priority === "core").sort(compareFact);
  const lines = facts.map((fact) => `- [${fact.id}] (${fact.kind}; ${fact.scope.type}${fact.scope.id ? `:${fact.scope.id}` : ""}) ${fact.statement}`);
  const summary = lines.join("\n");
  if (input.max_tokens !== undefined && conservativeTokenUpperBound({ summary, fact_ids: facts.map((fact) => fact.id) }) > input.max_tokens) throw new CoreError("VALIDATION_FAILED", "Core facts exceed the summary budget", { reason: "CORE_BUDGET_EXCEEDED" });
  return { summary, fact_ids: facts.map((fact) => fact.id), knowledge_revision: snapshot.knowledge_revision, generated_at: capturedNow, evaluated_at: evaluatedAt, valid_until: calculateValidUntil(snapshot.facts.values(), scopes, evaluatedAt) };
}
function compareFact(a: Fact, b: Fact): number { const scope = `${a.scope.type}:${a.scope.id ?? ""}`.localeCompare(`${b.scope.type}:${b.scope.id ?? ""}`, "en"); return scope || kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) || a.id.localeCompare(b.id, "en"); }
