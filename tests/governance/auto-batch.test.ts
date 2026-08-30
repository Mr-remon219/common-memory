import { afterEach, expect, it } from "vitest";
import { CoreService } from "../../src/core/service/core-service.js";
import { automatedGovernanceAuthority } from "../../src/core/contracts/ports.js";
import { batchId, operationId, payloadDigest } from "../../src/core/governance/governance-digest.js";
import { evidence, suggested, tempRoot, TestClock, TestIds } from "../helpers.js";
let cleanup: () => void = () => undefined; afterEach(() => cleanup());
it("commits an automatic Proposal+Review+Fact batch once and recovers idempotently", () => {
  const root = tempRoot(); cleanup = root.cleanup; const service = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids: new TestIds() }); const initialized = service.initialize(); if (!initialized.ok) throw new Error();
  const info = service.repositoryInfo(); if (!info.ok) throw new Error();
  const proposal = { operation: "add_fact" as const, target_fact_ids: [] as [], suggested_fact: { ...suggested, priority: "normal" as const }, evidence, reasoning: "明确用户偏好", confidence: "high" as const };
  const source = `sha256:${"3".repeat(64)}` as const; const payload = payloadDigest(proposal); const op = operationId("memory_analysis_v1", "extract", "p1", "add", payload, initialized.knowledge_revision!, initialized.store_revision!);
  const input = { batch_id: batchId(info.data.repository_id, "extract", "p1", source, initialized.knowledge_revision!, initialized.store_revision!), mode: "extract" as const, policy_version: "p1", source_digest: source, expected_knowledge_revision: initialized.knowledge_revision!, expected_store_revision: initialized.store_revision!, operations: [{ operation_id: op, intent: "add" as const, proposal_input: proposal }] };
  const first = service.autoGovernBatch(input, automatedGovernanceAuthority()); expect(first.ok && first.data.idempotent).toBe(false); if (!first.ok) throw new Error(JSON.stringify(first.error));
  expect(first.data.proposals[0]?.source.client).toBe("memory_manager"); expect(first.data.reviews[0]?.reviewer.type).toBe("memory_manager_policy"); expect(first.data.reviews[0]?.execution?.sequence).toBe(1);
  const second = service.autoGovernBatch(input, automatedGovernanceAuthority()); expect(second.ok && second.data.idempotent).toBe(true);
  const current = service.get({ scopes: ["global"] }); expect(current.ok && current.data.facts).toHaveLength(1);
});
it.each([
  { priority: "archive" as const, expires_at: null, provenance_type: "user_correction" as const },
  { priority: "normal" as const, expires_at: "2025-01-01T00:00:00.000Z", provenance_type: "user_correction" as const },
  { priority: "normal" as const, expires_at: null, provenance_type: "user_statement" as const }
])("rejects unauthorized or implicitly hidden replacement: %o", (invalid) => {
  const root = tempRoot(); cleanup = root.cleanup; const service = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids: new TestIds() }); const initialized = service.initialize(); if (!initialized.ok) throw new Error(); const info = service.repositoryInfo(); if (!info.ok) throw new Error();
  const add = { operation: "add_fact" as const, target_fact_ids: [] as [], suggested_fact: { ...suggested, priority: "normal" as const }, evidence, reasoning: "seed", confidence: "high" as const }; const source = `sha256:${"5".repeat(64)}` as const; const addOp = operationId("memory_analysis_v1", "extract", "p1", "add", payloadDigest(add), initialized.knowledge_revision!, initialized.store_revision!);
  const seeded = service.autoGovernBatch({ batch_id: batchId(info.data.repository_id, "extract", "p1", source, initialized.knowledge_revision!, initialized.store_revision!), mode: "extract", policy_version: "p1", source_digest: source, expected_knowledge_revision: initialized.knowledge_revision!, expected_store_revision: initialized.store_revision!, operations: [{ operation_id: addOp, intent: "add", proposal_input: add }] }, automatedGovernanceAuthority()); if (!seeded.ok) throw new Error(); const before = seeded.store_revision; const factId = seeded.data.resulting_fact_ids[0]!;
  const replace = { operation: "supersede_fact" as const, target_fact_ids: [factId], suggested_fact: { ...suggested, priority: invalid.priority, expires_at: invalid.expires_at }, evidence: { ...evidence, provenance_type: invalid.provenance_type }, reasoning: "replace", confidence: "high" as const }; const source2 = `sha256:${(invalid.priority === "archive" ? "6" : "7").repeat(64)}` as `sha256:${string}`; const op = operationId("memory_analysis_v1", "extract", "p1", "replace", payloadDigest(replace), seeded.knowledge_revision!, seeded.store_revision!);
  const rejected = service.autoGovernBatch({ batch_id: batchId(info.data.repository_id, "extract", "p1", source2, seeded.knowledge_revision!, seeded.store_revision!), mode: "extract", policy_version: "p1", source_digest: source2, expected_knowledge_revision: seeded.knowledge_revision!, expected_store_revision: seeded.store_revision!, operations: [{ operation_id: op, intent: "replace", proposal_input: replace }] }, automatedGovernanceAuthority()); expect(rejected.ok).toBe(false); expect(rejected.store_revision).toBe(before);
});
