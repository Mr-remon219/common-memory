import type { RecallCoreResult, RecallMode, RecallRequest, SearchResult } from "../core/contracts/dto.js";
import type { Revision } from "../core/contracts/types.js";
import type { ModelUsage } from "../memory-manager/contracts/model-port.js";

export interface RecallRouteDecision {
  contract_version: "recall_plan_v1";
  request_id: string;
  based_on_knowledge_revision: Revision;
  mode: RecallMode;
  queries: string[];
  reason: string;
}

export interface RecallPlannerInput {
  request: RecallRequest;
  requestId: string;
  knowledgeRevision: Revision;
  initialResults: readonly SearchResult[];
  initialRetrievalDegraded: boolean;
}

export interface RecallPlannerOptions { signal?: AbortSignal; deadlineMs: number }
export type RecallPlannerOutcome =
  | { kind: "decision"; decision: RecallRouteDecision; usage: ModelUsage }
  | { kind: "refusal"; usage: ModelUsage };
export interface RecallPlannerPort { plan(input: RecallPlannerInput, options: RecallPlannerOptions): Promise<RecallPlannerOutcome> }

export type RecallRouteWarning = "MODEL_ROUTING_DEGRADED" | "MODEL_ROUTING_REFUSED";
export interface RecallResult extends RecallCoreResult {
  index_revision: Revision | null;
  route: {
    status: "model" | "fallback";
    warning: RecallRouteWarning | null;
    reason: string;
  };
  warnings: string[];
  usage: ModelUsage;
}

export class RecallPlannerError extends Error {
  constructor(message = "Recall planner returned an invalid decision", options?: ErrorOptions) {
    super(message, options);
    this.name = "RecallPlannerError";
  }
}
