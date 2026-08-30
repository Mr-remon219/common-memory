import { afterEach, expect, it, vi } from "vitest";
import { CoreService } from "../../src/core/service/core-service.js";
import { MemoryManager } from "../../src/memory-manager/memory-manager.js";
import { digestText } from "../../src/memory-manager/retrieval.js";
import { tempRoot, TestClock, TestIds } from "../helpers.js";
let cleanup: () => void = () => undefined; afterEach(() => cleanup());
it("extracts a high-confidence fact through the trusted local batch policy", async () => {
  const root = tempRoot(); cleanup = root.cleanup; const core = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids: new TestIds() }); core.initialize(); const text = "用户默认使用中文交流";
  const manager = new MemoryManager({ core, requestId: () => "req_12345678", model: { analyze: async (request) => { const p = request.projection as Record<string, unknown>; return { kind: "output", usage: {}, body: { contract_version: "memory_analysis_v1", request_id: p.request_id, based_on_knowledge_revision: p.based_on_knowledge_revision, based_on_store_revision: p.based_on_store_revision, actions: [{ action: "add", confidence: "high", statement: text, kind: "preference", scope: "global", priority: "normal", target_fact_ids: [], evidence_refs: ["ev_1"], tags: ["communication"], expires_at: null, reason: "用户明确陈述" }], abstained_reason_codes: [] } }; } }, observations: { resolve: async (reference) => ({ ...reference, text, observedAt: "2026-01-01T00:00:00.000Z", sessionId: "s", reference: "m1" }) }, disclosurePolicy: { enabled: true, allowedScopes: ["global"], allowedProvenance: ["user_statement"], maxExcerptBytes: 1000, maxCandidateBytes: 1000, maxTotalBytes: 10000 } });
  const result = await manager.extract({ observations: [{ observationId: "o1", digest: digestText(text), scope: "global", provenance: "user_statement" }] }); expect(result.outcome).toBe("committed");
  const facts = core.get({ scopes: ["global"] }); expect(facts.ok && facts.data.facts[0]?.statement).toBe(text);
});
it("defers a pre-model double-revision race instead of terminally blocking it", async () => {
  const root = tempRoot(); cleanup = root.cleanup; const core = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids: new TestIds() }); core.initialize(); const text = "用户偏好简洁回答"; const analyze = vi.fn();
  const original = core.repositoryInfo.bind(core); core.repositoryInfo = (() => { const result = original(); return result.ok ? { ...result, data: { ...result.data, store_revision: `sha256:${"f".repeat(64)}` as const } } : result; }) as typeof core.repositoryInfo;
  const manager = new MemoryManager({ core, model: { analyze }, observations: { resolve: async (reference) => ({ ...reference, text, observedAt: "2026-01-01T00:00:00.000Z", sessionId: "s", reference: "m" }) }, disclosurePolicy: { enabled: true, allowedScopes: ["global"], allowedProvenance: ["user_statement"], maxExcerptBytes: 1000, maxCandidateBytes: 1000, maxTotalBytes: 5000 } });
  const result = await manager.extract({ observations: [{ observationId: "o1", digest: digestText(text), scope: "global", provenance: "user_statement" }] }); expect(result).toMatchObject({ outcome: "deferred", reason_code: "STALE_REVISION" }); expect(analyze).not.toHaveBeenCalled();
});
