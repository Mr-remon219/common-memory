import { afterEach, expect, it, vi } from "vitest";
import { CoreService } from "../../src/core/service/core-service.js";
import { MemoryManager } from "../../src/memory-manager/memory-manager.js";
import type { ObservationReference } from "../../src/memory-manager/contracts/observation.js";
import { digestText } from "../../src/memory-manager/retrieval.js";
import { tempRoot, TestClock, TestIds } from "../helpers.js";
let cleanup: () => void = () => undefined; afterEach(() => cleanup());
const policy = { enabled: true as const, allowedScopes: ["global"], allowedProvenance: ["user_statement" as const], maxExcerptBytes: 1000, maxCandidateBytes: 1000, maxTotalBytes: 5000 };
function observation(text: string) { return { references: [{ observationId: "o1", digest: digestText(text), scope: "global", provenance: "user_statement" as const }], source: { resolve: async (reference: ObservationReference) => ({ ...reference, text, observedAt: "2026-01-01T00:00:00.000Z", sessionId: "s", reference: "m" }) } }; }
it("records refusal only as a run outcome and leaves Canonical revisions unchanged", async () => {
  const root = tempRoot(); cleanup = root.cleanup; const core = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids: new TestIds() }); const init = core.initialize(); if (!init.ok) throw new Error(); const text = "用户偏好简洁回答"; const observed = observation(text); const manager = new MemoryManager({ core, observations: observed.source, disclosurePolicy: policy, model: { analyze: async () => ({ kind: "refusal", category: "provider_refusal", fingerprint: "fingerprint", usage: {} }) } });
  expect(await manager.extract({ observations: observed.references })).toMatchObject({ outcome: "refused" }); const after = core.repositoryInfo(); expect(after.ok && after.data.store_revision).toBe(init.store_revision); const log = core.listGovernance(); expect(log.ok && log.data.items).toHaveLength(0);
});
it("uses the committed source receipt to make crash recovery idempotent before another model call", async () => {
  const root = tempRoot(); cleanup = root.cleanup; const core = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids: new TestIds() }); const init = core.initialize(); if (!init.ok) throw new Error(); const text = "用户偏好简洁回答"; const observed = observation(text);
  const analyze = vi.fn(async (request: { projection: Readonly<Record<string, unknown>> }) => ({ kind: "output" as const, usage: {}, body: { contract_version: "memory_analysis_v1", request_id: request.projection.request_id, based_on_knowledge_revision: request.projection.based_on_knowledge_revision, based_on_store_revision: request.projection.based_on_store_revision, actions: [{ action: "add", confidence: "high", statement: text, kind: "preference", scope: "global", priority: "normal", target_fact_ids: [], evidence_refs: ["ev_1"], tags: [], expires_at: null, reason: "explicit" }], abstained_reason_codes: [] } }));
  const manager = new MemoryManager({ core, observations: observed.source, disclosurePolicy: policy, model: { analyze } });
  expect(await manager.extract({ observations: observed.references })).toMatchObject({ outcome: "committed" });
  expect(await manager.extract({ observations: observed.references })).toMatchObject({ outcome: "idempotent" });
  expect(analyze).toHaveBeenCalledTimes(1);
});

it("reanalyzes once after commit STALE and defers the second without partial writes", async () => {
  const root = tempRoot(); cleanup = root.cleanup; const core = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids: new TestIds() }); const init = core.initialize(); if (!init.ok) throw new Error(); const text = "用户偏好简洁回答"; const observed = observation(text); const analyze = vi.fn(async (request: { projection: Readonly<Record<string, unknown>> }) => ({ kind: "output" as const, usage: {}, body: { contract_version: "memory_analysis_v1", request_id: request.projection.request_id, based_on_knowledge_revision: request.projection.based_on_knowledge_revision, based_on_store_revision: request.projection.based_on_store_revision, actions: [{ action: "add", confidence: "high", statement: text, kind: "preference", scope: "global", priority: "normal", target_fact_ids: [], evidence_refs: ["ev_1"], tags: [], expires_at: null, reason: "explicit" }], abstained_reason_codes: [] } }));
  core.autoGovernBatch = ((input) => ({ ok: false, schema_version: 1, knowledge_revision: input.expected_knowledge_revision, store_revision: input.expected_store_revision, index_revision: null, warnings: [], error: { code: "STALE_REVISION", message: "stale", details: {} } })) as typeof core.autoGovernBatch;
  const manager = new MemoryManager({ core, observations: observed.source, disclosurePolicy: policy, model: { analyze } }); expect(await manager.extract({ observations: observed.references })).toMatchObject({ outcome: "deferred", reason_code: "STALE_REVISION" }); expect(analyze).toHaveBeenCalledTimes(2); const after = core.repositoryInfo(); expect(after.ok && after.data.store_revision).toBe(init.store_revision); const log = core.listGovernance(); expect(log.ok && log.data.items).toHaveLength(0);
});
