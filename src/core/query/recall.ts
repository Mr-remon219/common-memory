import type { ContextPackInput, RecallCoreResult, RecallPlan, RecallRequest, SearchInput, SearchResult } from "../contracts/dto.js";
import { CoreError } from "../contracts/errors.js";
import type { Revision } from "../contracts/types.js";
import { buildContextPack } from "../context/context-pack.js";
import type { LockedRepositorySession } from "../repository/locked-session.js";
import { searchFacts } from "../search/search.js";
import { reciprocalRankFuse, RECALL_RRF_K } from "../search/rrf.js";

const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const FACT_ID = /^fact\.[A-Za-z0-9_-]{8,128}$/u;
const MAX_QUERY_BYTES = 4_096;
const MAX_CONTEXT_BYTES = 100_000;

export function executeRecall(session: LockedRepositorySession, plan: RecallPlan, capturedNow: string): RecallCoreResult {
  validatePlan(plan);
  if (plan.expected_knowledge_revision !== session.snapshot.knowledge_revision) {
    throw new CoreError("STALE_REVISION", "Recall plan is based on a stale knowledge revision", {
      expected_knowledge_revision: plan.expected_knowledge_revision,
      current_knowledge_revision: session.snapshot.knowledge_revision,
    });
  }
  const request = plan.request;
  const packInput = contextPackInput(request);
  try {
    const relevant = fuseQueries(session, plan.queries, request, capturedNow, false);
    const historical = request.include_history && request.time_range
      ? fuseQueries(session, plan.queries, request, capturedNow, true)
      : [];
    return result(plan, buildContextPack(session.snapshot, packInput, capturedNow, relevant, historical, false));
  } catch (error) {
    if (error instanceof CoreError && error.code === "INDEX_OUTDATED") {
      return result(plan, buildContextPack(session.snapshot, packInput, capturedNow, [], [], true));
    }
    throw error;
  }
}

function fuseQueries(session: LockedRepositorySession, queries: readonly string[], request: RecallRequest, capturedNow: string, includeHistory: boolean): SearchResult[] {
  const resultSets = queries.map((query) => searchFacts(session, searchInput(request, query, includeHistory), capturedNow));
  const excluded = new Set(request.exclude_fact_ids ?? []);
  return reciprocalRankFuse(resultSets, 100).filter((item) => !excluded.has(item.fact.id)).slice(0, request.limit ?? 10);
}

function searchInput(request: RecallRequest, query: string, includeHistory: boolean): SearchInput {
  return {
    query,
    scopes: [...request.scopes],
    limit: 100,
    include_history: includeHistory,
    ...(request.kinds !== undefined ? { kinds: [...request.kinds] } : {}),
    ...(request.tags !== undefined ? { tags: [...request.tags] } : {}),
    ...(request.time_range !== undefined ? { time_range: request.time_range } : {}),
    ...(request.valid_at !== undefined ? { valid_at: request.valid_at } : {}),
  };
}

function contextPackInput(request: RecallRequest): ContextPackInput {
  return {
    task: request.query,
    scopes: [...request.scopes],
    max_tokens: request.max_context_bytes,
    ...(request.kinds !== undefined ? { kinds: [...request.kinds] } : {}),
    ...(request.tags !== undefined ? { tags: [...request.tags] } : {}),
    ...(request.time_range !== undefined ? { time_range: request.time_range } : {}),
    ...(request.include_history !== undefined ? { include_history: request.include_history } : {}),
    ...(request.valid_at !== undefined ? { valid_at: request.valid_at } : {}),
  };
}

function result(plan: RecallPlan, pack: RecallCoreResult["pack"]): RecallCoreResult {
  return { contract_version: "recall_result_v1", request_id: plan.request_id, mode: plan.mode, queries: [...plan.queries], rrf_k: RECALL_RRF_K, pack };
}

function validatePlan(plan: RecallPlan): void {
  if (!plan || plan.contract_version !== "recall_plan_v1" || !REQUEST_ID.test(plan.request_id) || !isRevision(plan.expected_knowledge_revision)) invalid("plan.contract");
  if (!new Set(["algorithm", "hybrid", "model_led"]).has(plan.mode)) invalid("plan.mode");
  if (!Array.isArray(plan.queries) || plan.queries.length < 1 || plan.queries.length > 3) invalid("plan.queries");
  const queries = plan.queries.map((query) => typeof query === "string" ? query.trim() : "");
  if (queries.some((query) => !query || Buffer.byteLength(query, "utf8") > MAX_QUERY_BYTES) || new Set(queries).size !== queries.length) invalid("plan.queries");
  validateRequest(plan.request);
  const original = plan.request.query.trim();
  if (plan.mode === "algorithm" && (queries.length !== 1 || queries[0] !== original)) invalid("plan.algorithm_query");
  if (plan.mode === "hybrid" && queries[0] !== original) invalid("plan.hybrid_query");
  if (typeof plan.reason !== "string" || Buffer.byteLength(plan.reason, "utf8") > 2_000) invalid("plan.reason");
}

function validateRequest(request: RecallRequest): void {
  if (!request || typeof request.query !== "string" || !request.query.trim() || Buffer.byteLength(request.query, "utf8") > MAX_QUERY_BYTES) invalid("request.query");
  if (!Array.isArray(request.scopes) || request.scopes.length < 1) invalid("request.scopes");
  if (!Number.isSafeInteger(request.max_context_bytes) || request.max_context_bytes < 1 || request.max_context_bytes > MAX_CONTEXT_BYTES) invalid("request.max_context_bytes");
  if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 50)) invalid("request.limit");
  if (request.exclude_fact_ids !== undefined && (!Array.isArray(request.exclude_fact_ids) || new Set(request.exclude_fact_ids).size !== request.exclude_fact_ids.length || request.exclude_fact_ids.some((id) => !FACT_ID.test(id)))) invalid("request.exclude_fact_ids");
}

function isRevision(value: unknown): value is Revision { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value); }
function invalid(reason: string): never { throw new CoreError("VALIDATION_FAILED", "Invalid recall plan", { reason }); }
