import { randomUUID } from "node:crypto";
import type { RecallCoreResult, RecallPlan, RecallRequest, SearchInput, SearchResult } from "../core/contracts/dto.js";
import { CoreError, type ErrorCode } from "../core/contracts/errors.js";
import type { Revision } from "../core/contracts/types.js";
import type { CoreResponse } from "../core/service/responses.js";
import { MemoryModelError } from "../memory-manager/contracts/errors.js";
import type { ModelUsage } from "../memory-manager/contracts/model-port.js";
import type { RecallPlannerOutcome, RecallPlannerPort, RecallResult, RecallRouteDecision, RecallRouteWarning } from "./contracts.js";
import { validateRecallRouteDecision } from "./plan-validator.js";

export interface RecallCorePort {
  search(input: SearchInput): CoreResponse<SearchResult[]>;
  recall(plan: RecallPlan): CoreResponse<RecallCoreResult>;
}
export interface RecallOrchestratorOptions { core: RecallCorePort; planner: RecallPlannerPort; requestId?: () => string; deadlineMs?: number }
export interface RecallExecutionOptions { signal?: AbortSignal; deadlineMs?: number }

export class RecallOrchestrator {
  readonly #core: RecallCorePort;
  readonly #planner: RecallPlannerPort;
  readonly #requestId: () => string;
  readonly #deadlineMs: number;

  constructor(options: RecallOrchestratorOptions) {
    this.#core = options.core;
    this.#planner = options.planner;
    this.#requestId = options.requestId ?? (() => `recall_${randomUUID().replaceAll("-", "")}`);
    this.#deadlineMs = options.deadlineMs ?? 3_000;
    if (!Number.isSafeInteger(this.#deadlineMs) || this.#deadlineMs <= 0) throw new TypeError("deadlineMs must be a positive integer");
  }

  async recall(rawRequest: RecallRequest, options: RecallExecutionOptions = {}): Promise<RecallResult> {
    const request = normalizeRequest(rawRequest);
    const requestId = this.#requestId();
    const deadlineMs = options.deadlineMs ?? this.#deadlineMs;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new TypeError("deadlineMs must be a positive integer");
    let totalUsage: ModelUsage = {};
    for (let attempt = 0; attempt < 2; attempt++) {
      throwIfAborted(options.signal);
      const initial = this.#initialSearch(request);
      const route = await this.#route(request, requestId, initial.knowledgeRevision, initial.results, initial.degraded, deadlineMs, options.signal);
      totalUsage = addUsage(totalUsage, route.usage);
      throwIfAborted(options.signal);
      const plan: RecallPlan = {
        contract_version: "recall_plan_v1",
        request_id: requestId,
        expected_knowledge_revision: initial.knowledgeRevision,
        mode: route.decision.mode,
        queries: [...route.decision.queries],
        reason: route.decision.reason,
        request,
      };
      const recalled = this.#core.recall(plan);
      if (!recalled.ok && recalled.error.code === "STALE_REVISION" && attempt === 0) continue;
      if (!recalled.ok) throw coreFailure(recalled);
      const warnings = [...new Set([...recalled.data.pack.warnings, ...(route.warning ? [route.warning] : [])])];
      return {
        ...recalled.data,
        index_revision: recalled.index_revision,
        route: { status: route.warning ? "fallback" : "model", warning: route.warning, reason: route.decision.reason },
        warnings,
        usage: totalUsage,
      };
    }
    throw new CoreError("STALE_REVISION", "Recall could not obtain a stable knowledge revision");
  }

  #initialSearch(request: RecallRequest): { results: SearchResult[]; knowledgeRevision: Revision; degraded: boolean } {
    const response = this.#core.search({
      query: request.query,
      scopes: [...request.scopes],
      limit: Math.min(100, Math.max(10, (request.limit ?? 10) * 3)),
      include_history: false,
      ...(request.kinds !== undefined ? { kinds: [...request.kinds] } : {}),
      ...(request.tags !== undefined ? { tags: [...request.tags] } : {}),
      ...(request.time_range !== undefined ? { time_range: request.time_range } : {}),
      ...(request.valid_at !== undefined ? { valid_at: request.valid_at } : {}),
    });
    if (response.ok) return { results: response.data, knowledgeRevision: requiredRevision(response.knowledge_revision), degraded: false };
    if (response.error.code === "INDEX_OUTDATED" && response.knowledge_revision) return { results: [], knowledgeRevision: response.knowledge_revision, degraded: true };
    throw coreFailure(response);
  }

  async #route(request: RecallRequest, requestId: string, knowledgeRevision: Revision, initialResults: SearchResult[], initialRetrievalDegraded: boolean, deadlineMs: number, signal?: AbortSignal): Promise<{ decision: RecallRouteDecision; warning: RecallRouteWarning | null; usage: ModelUsage }> {
    try {
      const outcome = await this.#planner.plan(
        { request, requestId, knowledgeRevision, initialResults, initialRetrievalDegraded },
        { deadlineMs, ...(signal ? { signal } : {}) },
      );
      throwIfAborted(signal);
      if (outcome.kind === "refusal") return fallback(request, requestId, knowledgeRevision, "MODEL_ROUTING_REFUSED", outcome);
      const decision = validateRecallRouteDecision(outcome.decision, { requestId, knowledgeRevision, request });
      return { decision, warning: null, usage: outcome.usage };
    } catch (error) {
      if (signal?.aborted || error instanceof MemoryModelError && error.code === "CANCELLED" || error instanceof DOMException && error.name === "AbortError") throw abortError();
      return fallback(request, requestId, knowledgeRevision, "MODEL_ROUTING_DEGRADED");
    }
  }
}

function fallback(request: RecallRequest, requestId: string, knowledgeRevision: Revision, warning: RecallRouteWarning, outcome?: RecallPlannerOutcome): { decision: RecallRouteDecision; warning: RecallRouteWarning; usage: ModelUsage } {
  return {
    decision: { contract_version: "recall_plan_v1", request_id: requestId, based_on_knowledge_revision: knowledgeRevision, mode: "algorithm", queries: [request.query], reason: "deterministic local fallback" },
    warning,
    usage: outcome?.usage ?? {},
  };
}

function normalizeRequest(request: RecallRequest): RecallRequest {
  if (!request || typeof request.query !== "string" || !request.query.trim() || Buffer.byteLength(request.query, "utf8") > 4_096) throw new CoreError("VALIDATION_FAILED", "Recall query must be between 1 and 4096 bytes");
  if (!Array.isArray(request.scopes) || request.scopes.length < 1) throw new CoreError("VALIDATION_FAILED", "Recall scopes are required");
  if (!Number.isSafeInteger(request.max_context_bytes) || request.max_context_bytes < 1 || request.max_context_bytes > 100_000) throw new CoreError("VALIDATION_FAILED", "Invalid recall context budget");
  if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 50)) throw new CoreError("VALIDATION_FAILED", "Invalid recall result limit");
  if (request.exclude_fact_ids !== undefined && (!Array.isArray(request.exclude_fact_ids) || new Set(request.exclude_fact_ids).size !== request.exclude_fact_ids.length || request.exclude_fact_ids.some((id) => !/^fact\.[A-Za-z0-9_-]{8,128}$/u.test(id)))) throw new CoreError("VALIDATION_FAILED", "Invalid excluded fact IDs");
  const normalized: RecallRequest = {
    query: request.query.trim(),
    scopes: [...request.scopes],
    max_context_bytes: request.max_context_bytes,
    ...(request.limit !== undefined ? { limit: request.limit } : {}),
    ...(request.kinds !== undefined ? { kinds: [...request.kinds] } : {}),
    ...(request.tags !== undefined ? { tags: [...request.tags] } : {}),
    ...(request.time_range === null ? { time_range: null } : request.time_range !== undefined ? { time_range: { from: request.time_range.from, to: request.time_range.to } } : {}),
    ...(request.include_history !== undefined ? { include_history: request.include_history } : {}),
    ...(request.valid_at !== undefined ? { valid_at: request.valid_at } : {}),
    ...(request.exclude_fact_ids !== undefined ? { exclude_fact_ids: [...request.exclude_fact_ids] } : {}),
  };
  return deepFreeze(normalized);
}

function requiredRevision(value: Revision | null): Revision { if (!value) throw new CoreError("PROTOCOL_ERROR", "Core response omitted knowledge revision"); return value; }
function addUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  const inputTokens = (left.inputTokens ?? 0) + (right.inputTokens ?? 0);
  const outputTokens = (left.outputTokens ?? 0) + (right.outputTokens ?? 0);
  const totalTokens = (left.totalTokens ?? 0) + (right.totalTokens ?? 0);
  return {
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(totalTokens > 0 ? { totalTokens } : {}),
  };
}
function coreFailure(response: Extract<CoreResponse<unknown>, { ok: false }>): CoreError { return new CoreError(response.error.code as ErrorCode, response.error.message, response.error.details); }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw abortError(); }
function abortError(): DOMException { return new DOMException("Memory recall was cancelled", "AbortError"); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
