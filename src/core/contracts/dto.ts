import type { Fact, FactKind, FactStatus, GovernanceIntent, GovernanceMode, Proposal, Review, Revision, SuggestedFact, Evidence, TimeRange } from "./types.js";

export interface ProposeInput {
  operation: "add_fact" | "supersede_fact" | "expire_fact";
  target_fact_ids: string[];
  suggested_fact?: SuggestedFact;
  suggested_expiration?: { expires_at: string; reason: string };
  evidence: Evidence;
  reasoning: string;
  confidence: "low" | "medium" | "high";
}
export interface GovernanceInput { proposal_id: string; expected_store_revision: Revision; note?: string | null }
export interface EditApproveInput extends GovernanceInput {
  edits: Partial<Pick<SuggestedFact, "statement" | "kind" | "scope" | "priority" | "valid_from" | "expires_at" | "tags">> & {
    target_fact_ids?: string[];
    expires_at?: string;
    reason?: string;
  };
}
export interface GetInput {
  ids?: string[]; kinds?: FactKind[]; scopes: string[]; statuses?: FactStatus[];
  valid_at?: string; include_history?: boolean; time_range?: TimeRange | null;
}
export interface SummaryInput { scopes: string[]; max_tokens?: number; valid_at?: string }
export interface SearchInput {
  query: string; scopes: string[]; kinds?: FactKind[]; tags?: string[]; time_range?: TimeRange | null;
  limit?: number; include_history?: boolean; valid_at?: string;
}
export interface ContextPackInput extends Omit<SearchInput, "query"> { task: string; max_tokens: number }
export type RecallMode = "algorithm" | "hybrid" | "model_led";
export interface RecallRequest extends Omit<SearchInput, "query" | "limit"> {
  query: string;
  max_context_bytes: number;
  limit?: number;
  exclude_fact_ids?: string[];
}
export interface RecallPlan {
  contract_version: "recall_plan_v1";
  request_id: string;
  expected_knowledge_revision: Revision;
  mode: RecallMode;
  queries: string[];
  reason: string;
  request: RecallRequest;
}
export interface FactSelection { fact: Fact; reason: string }
export interface SearchResult {
  fact: Fact; raw_bm25: number | null; lexical_rank: number;
  boosts: { exact_tag: number; exact_scope: number; priority: number; temporal: number; provenance: number };
  final_score: number; matched_fields: string[]; fallback: "fts5" | "short-query";
  match_reasons: string[];
}
export interface ContextPackItem {
  id: string;
  statement: string;
  kind: FactKind;
  scope: Fact["scope"];
  validity: Fact["validity"];
  source: { type: Fact["provenance"]["type"]; source_client: Fact["provenance"]["source_client"]; reference: string | null };
  provenance_details?: { session_id: string | null; note: string | null; observed_at: string; received_at: string };
  reason: string;
}
export interface ContextPackDto {
  knowledge_revision: Revision;
  evaluated_at: string;
  valid_until: string | null;
  core: ContextPackItem[];
  boundaries: ContextPackItem[];
  relevant: ContextPackItem[];
  historical: ContextPackItem[];
  warnings: string[];
  degraded: boolean;
}
export interface RecallCoreResult {
  contract_version: "recall_result_v1";
  request_id: string;
  mode: RecallMode;
  queries: string[];
  rrf_k: number;
  pack: ContextPackDto;
}
export interface RevisionsDto { knowledge_revision: Revision; store_revision: Revision; index_revision: Revision | null }
export type WarningCode = "INDEX_OUTDATED";

export interface AutoGovernOperationInput { operation_id: string; intent: GovernanceIntent; proposal_input: ProposeInput }
export interface AutoGovernBatchInput {
  batch_id: string;
  mode: Exclude<GovernanceMode, "compensation">;
  policy_version: string;
  source_digest: Revision;
  expected_knowledge_revision: Revision;
  expected_store_revision: Revision;
  operations: AutoGovernOperationInput[];
}
export interface GovernanceBatchDto { batch_id: string; proposals: Proposal[]; reviews: Review[]; resulting_fact_ids: string[]; knowledge_revision: Revision; store_revision: Revision; idempotent: boolean }
export interface GovernanceLogInput { cursor?: string; limit?: number; batch_id?: string }
export interface GovernanceLogPage { items: Array<{ proposal: Proposal; review: Review | null }>; next_cursor: string | null; store_revision: Revision }
export interface UndoPreviewInput { review_ids: string[] }
export interface UndoPlanItem { reverts_review_id: string; operation: "archive_result" | "restore_fact"; fact_id: string; statement: string; kind: FactKind; scope: Fact["scope"]; priority: Fact["priority"]; valid_from: string | null; expires_at: string | null; tags: string[] }
export interface UndoPreviewDto { compensation_batch_id: string; plan_digest: Revision; base_knowledge_revision: Revision; base_store_revision: Revision; planned_at: string; review_ids: string[]; plan: UndoPlanItem[] }
export interface ApplyUndoInput { preview: UndoPreviewDto }
