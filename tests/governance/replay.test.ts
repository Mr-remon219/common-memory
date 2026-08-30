import { afterEach, expect, it } from "vitest";
import { CoreService } from "../../src/core/service/core-service.js";
import { automatedGovernanceAuthority } from "../../src/core/contracts/ports.js";
import { batchId, operationId, payloadDigest } from "../../src/core/governance/governance-digest.js";
import { evidence, suggested, tempRoot, TestClock, TestIds } from "../helpers.js";
let cleanup: () => void = () => undefined; afterEach(() => cleanup());
it("replays a two-operation automatic macro batch with contiguous review revisions", () => {
  const root = tempRoot(); cleanup = root.cleanup; const core = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids: new TestIds() }); const init = core.initialize(); if (!init.ok) throw new Error(); const info = core.repositoryInfo(); if (!info.ok) throw new Error(); const source = `sha256:${"4".repeat(64)}` as const;
  const proposals = ["中文", "TypeScript"].map((value) => ({ operation: "add_fact" as const, target_fact_ids: [] as [], suggested_fact: { ...suggested, statement: value, priority: "normal" as const }, evidence, reasoning: value, confidence: "high" as const }));
  const operations = proposals.map((proposal) => ({ operation_id: operationId("memory_analysis_v1", "extract", "p1", "add", payloadDigest(proposal), init.knowledge_revision!, init.store_revision!), intent: "add" as const, proposal_input: proposal }));
  const result = core.autoGovernBatch({ batch_id: batchId(info.data.repository_id, "extract", "p1", source, init.knowledge_revision!, init.store_revision!), mode: "extract", policy_version: "p1", source_digest: source, expected_knowledge_revision: init.knowledge_revision!, expected_store_revision: init.store_revision!, operations }, automatedGovernanceAuthority()); if (!result.ok) throw new Error(JSON.stringify(result.error));
  expect(result.data.reviews).toHaveLength(2); const first = result.data.reviews[0]!; expect(first.decision).toBe("approved"); if (first.decision !== "approved") throw new Error(); expect(first.resulting_store_revision).toBe(result.data.reviews[1]!.based_on_store_revision); expect(core.diagnose().ok).toBe(true);
});
