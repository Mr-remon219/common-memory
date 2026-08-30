import type { FactKind, Priority, Revision } from "../../core/contracts/types.js";

export type MemoryAnalysisMode = "extract" | "consolidate";
export type MemoryActionName = "add" | "modify" | "replace" | "merge" | "distill" | "expire" | "archive" | "no_op";
export interface MemoryAnalysisAction {
  action: MemoryActionName;
  confidence: "low" | "medium" | "high";
  statement: string | null;
  kind: FactKind | null;
  scope: string | null;
  priority: Priority | null;
  target_fact_ids: string[];
  evidence_refs: string[];
  tags: string[];
  expires_at: string | null;
  reason: string;
}
export interface MemoryAnalysis {
  contract_version: "memory_analysis_v1";
  request_id: string;
  based_on_knowledge_revision: Revision;
  based_on_store_revision: Revision;
  actions: MemoryAnalysisAction[];
  abstained_reason_codes: string[];
}
export interface AnalysisRequestContext {
  requestId: string;
  mode: MemoryAnalysisMode;
  knowledgeRevision: Revision;
  storeRevision: Revision;
  evidenceRefs: ReadonlySet<string>;
  candidateFactIds: ReadonlySet<string>;
  allowedScopes: ReadonlySet<string>;
  maxWriteActions: number;
}
