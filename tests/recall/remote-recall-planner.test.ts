import { expect, it, vi } from "vitest";
import type { Revision } from "../../src/core/contracts/types.js";
import { RemoteRecallPlanner } from "../../src/recall/remote-recall-planner.js";

it("uses the dedicated strict recall schema and validates revision echoes", async () => {
  const revision = `sha256:${"b".repeat(64)}` as Revision;
  const analyze = vi.fn(async (request: { schemaName?: string; projection: Readonly<Record<string, unknown>> }) => ({
    kind: "output" as const,
    usage: { totalTokens: 3 },
    body: {
      contract_version: "recall_plan_v1",
      request_id: request.projection.request_id,
      based_on_knowledge_revision: request.projection.based_on_knowledge_revision,
      mode: "algorithm",
      queries: [request.projection.query],
      reason: "initial retrieval is sufficient",
    },
  }));
  const planner = new RemoteRecallPlanner({
    model: { analyze },
    disclosurePolicy: { enabled: true, allowedScopes: ["global"], allowedProvenance: ["user_statement"], maxExcerptBytes: 1000, maxCandidateBytes: 1000, maxTotalBytes: 5000 },
  });
  const outcome = await planner.plan({ request: { query: "沟通偏好", scopes: ["global"], max_context_bytes: 8000 }, requestId: "recall_test_0001", knowledgeRevision: revision, initialResults: [], initialRetrievalDegraded: false }, { deadlineMs: 1000 });
  expect(outcome.kind).toBe("decision");
  expect(analyze.mock.calls[0]?.[0].schemaName).toBe("recall_plan_v1");
});
