import { CoreError } from "../core/contracts/errors.js";
import type { Fact, ProvenanceType } from "../core/contracts/types.js";
import type { MemoryAnalysis, MemoryAnalysisMode } from "./contracts/analysis.js";
export function enforceLocalMemoryPolicy(analysis: MemoryAnalysis, mode: MemoryAnalysisMode, candidates: ReadonlyMap<string, Fact>, evidenceProvenance: ReadonlyMap<string, ProvenanceType>): void {
  for (const action of analysis.actions) {
    if (action.action === "no_op") continue;
    if (action.confidence !== "high") denied("policy.high_confidence");
    const targets = action.target_fact_ids.map((id) => candidates.get(id)!);
    if (action.action !== "archive" && action.priority === "archive") denied("policy.archive_intent_required");
    if (action.action !== "archive" && action.action !== "expire" && action.expires_at !== null && Date.parse(action.expires_at) <= Date.now()) denied("policy.current_replacement_required");
    if (action.priority === "core" && (action.action === "add" || targets.every((fact) => fact.priority !== "core"))) denied("policy.create_core");
    if (mode === "consolidate" && targets.some((fact) => fact.priority === "core")) denied("policy.consolidate_core");
    if (targets.some((fact) => fact.priority === "core")) {
      const explicitCorrection = new Set(["modify", "replace"]).has(action.action) && action.evidence_refs.some((ref) => evidenceProvenance.get(ref) === "user_correction") && action.priority === "core";
      if (!explicitCorrection) denied("policy.core_correction_required");
    }
    if (mode === "extract" && new Set(["modify", "replace", "expire"]).has(action.action) && evidenceProvenance.get(action.evidence_refs[0]!) !== "user_correction") denied(action.action === "expire" ? "policy.explicit_forgetting_required" : "policy.explicit_correction_required");
  }
}
function denied(rule_id: string): never { throw new CoreError("PERMISSION_DENIED", "Automatic memory policy rejected the analysis", { rule_id }); }
