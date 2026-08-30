import { describe, expect, it, vi } from "vitest";
import type { RecallCoreResult, RecallRequest, SearchInput } from "../../src/core/contracts/dto.js";
import type { Revision } from "../../src/core/contracts/types.js";
import type { CoreResponse } from "../../src/core/service/responses.js";
import { MemoryModelError } from "../../src/memory-manager/contracts/errors.js";
import type { RecallPlannerPort } from "../../src/recall/contracts.js";
import { RecallOrchestrator, type RecallCorePort } from "../../src/recall/recall-orchestrator.js";

const R1 = `sha256:${"1".repeat(64)}` as Revision;
const R2 = `sha256:${"2".repeat(64)}` as Revision;
const request: RecallRequest = { query: "Windows 网络历史", scopes: ["global"], max_context_bytes: 8_000, limit: 5 };

function response<T>(revision: Revision, data: T): CoreResponse<T> {
  return { ok: true, schema_version: 1, knowledge_revision: revision, store_revision: revision, index_revision: revision, warnings: [], data };
}
function coreResult(revision: Revision, mode: RecallCoreResult["mode"] = "algorithm"): RecallCoreResult {
  return {
    contract_version: "recall_result_v1",
    request_id: "recall_test_0001",
    mode,
    queries: [request.query],
    rrf_k: 60,
    pack: { knowledge_revision: revision, evaluated_at: "2026-01-01T00:00:00.000Z", valid_until: null, core: [], boundaries: [], relevant: [], historical: [], warnings: [], degraded: false },
  };
}
function stableCore(revision = R1): RecallCorePort {
  return { search: (_input: SearchInput) => response(revision, []), recall: (plan) => response(revision, { ...coreResult(revision, plan.mode), request_id: plan.request_id, queries: plan.queries }) };
}
function validPlanner(mode: "algorithm" | "hybrid" | "model_led" = "algorithm"): RecallPlannerPort {
  return { plan: async (input) => ({ kind: "decision", usage: { totalTokens: 7 }, decision: { contract_version: "recall_plan_v1", request_id: input.requestId, based_on_knowledge_revision: input.knowledgeRevision, mode, queries: mode === "algorithm" ? [input.request.query] : [input.request.query, "网络 修复"], reason: "validated route" } }) };
}

describe("RecallOrchestrator", () => {
  it("uses a validated model route and returns only the Core recall pack", async () => {
    const result = await new RecallOrchestrator({ core: stableCore(), planner: validPlanner("hybrid"), requestId: () => "recall_test_0001" }).recall(request);
    expect(result.route).toMatchObject({ status: "model", warning: null });
    expect(result.mode).toBe("hybrid");
    expect(result.queries).toEqual([request.query, "网络 修复"]);
    expect(result.pack.knowledge_revision).toBe(R1);
  });

  it.each([
    ["refusal", { plan: async () => ({ kind: "refusal" as const, usage: {} }) }],
    ["timeout", { plan: async () => { throw new MemoryModelError("TIMEOUT", "elapsed", true); } }],
    ["invalid", { plan: async (input: Parameters<RecallPlannerPort["plan"]>[0]) => ({ kind: "decision" as const, usage: {}, decision: { contract_version: "recall_plan_v1" as const, request_id: input.requestId, based_on_knowledge_revision: input.knowledgeRevision, mode: "algorithm" as const, queries: ["changed query"], reason: "invalid" } }) }],
  ])("degrades %s routing failure to the deterministic algorithm plan", async (_name, planner) => {
    const result = await new RecallOrchestrator({ core: stableCore(), planner, requestId: () => "recall_test_0001" }).recall(request);
    expect(result.route.status).toBe("fallback");
    expect(result.mode).toBe("algorithm");
    expect(result.queries).toEqual([request.query]);
    expect(result.pack.knowledge_revision).toBe(R1);
  });

  it("discards one stale plan and reroutes against the fresh knowledge revision", async () => {
    const search = vi.fn()
      .mockReturnValueOnce(response(R1, []))
      .mockReturnValueOnce(response(R2, []));
    const recall = vi.fn()
      .mockReturnValueOnce({ ok: false, schema_version: 1, knowledge_revision: R2, store_revision: R2, index_revision: R2, warnings: [], error: { code: "STALE_REVISION", message: "stale", details: {} } })
      .mockImplementationOnce((plan) => response(R2, { ...coreResult(R2), request_id: plan.request_id, queries: plan.queries }));
    const planner = validPlanner(); const route = vi.spyOn(planner, "plan");
    const result = await new RecallOrchestrator({ core: { search, recall }, planner, requestId: () => "recall_test_0001" }).recall(request);
    expect(result.pack.knowledge_revision).toBe(R2);
    expect(search).toHaveBeenCalledTimes(2); expect(recall).toHaveBeenCalledTimes(2); expect(route).toHaveBeenCalledTimes(2);
  });

  it("propagates cancellation without converting it into local fallback", async () => {
    const controller = new AbortController(); let received: AbortSignal | undefined;
    const planner: RecallPlannerPort = { plan: async (_input, options) => new Promise((_resolve, reject) => { received = options.signal; options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }); }) };
    const recall = vi.fn(); const pending = new RecallOrchestrator({ core: { search: stableCore().search, recall }, planner, requestId: () => "recall_test_0001" }).recall(request, { signal: controller.signal });
    await Promise.resolve(); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(received).toBe(controller.signal); expect(recall).not.toHaveBeenCalled();
  });
});
