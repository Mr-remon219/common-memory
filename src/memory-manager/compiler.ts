import type { ProposeInput } from "../core/contracts/dto.js";
import type { Fact, Scope } from "../core/contracts/types.js";
import type { MemoryAnalysisAction } from "./contracts/analysis.js";
import type { ResolvedObservation } from "./contracts/observation.js";
export function compileAction(action: MemoryAnalysisAction, evidence: ReadonlyMap<string, ResolvedObservation>, candidates: ReadonlyMap<string, Fact>): ProposeInput | null {
  if (action.action === "no_op") return null;
  const observed = evidence.get(action.evidence_refs[0]!)!;
  const common = { target_fact_ids: action.target_fact_ids, evidence: { provenance_type: observed.provenance, session_id: observed.sessionId, reference: observed.reference, observed_at: observed.observedAt }, reasoning: action.reason, confidence: action.confidence } as const;
  if (action.action === "expire") return { ...common, operation: "expire_fact", suggested_expiration: { expires_at: action.expires_at!, reason: action.reason } };
  let statement = action.statement!; let kind = action.kind!; let priority = action.priority!; let tags = action.tags; let expiresAt = action.expires_at; let validFrom: string | null = null;
  if (action.action === "archive") { const target = candidates.get(action.target_fact_ids[0]!)!; statement = target.statement; kind = target.kind; priority = "archive"; tags = target.tags; expiresAt = target.validity.expires_at; validFrom = target.validity.valid_from; }
  return { ...common, operation: action.action === "add" ? "add_fact" : "supersede_fact", suggested_fact: { statement, kind, scope: parseScope(action.scope!), priority, valid_from: validFrom, expires_at: expiresAt, tags } };
}
export function parseScope(value: string): Scope { if (value === "global") return { type: "global", id: null }; const split = value.indexOf(":"); const type = value.slice(0, split); const id = value.slice(split + 1); if (!new Set(["project", "agent", "device"]).has(type) || !id) throw new TypeError("Invalid scope token"); return { type: type as "project" | "agent" | "device", id }; }
