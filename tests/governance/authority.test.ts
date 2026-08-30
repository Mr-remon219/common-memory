import { afterEach, expect, it } from "vitest";
import { CoreService } from "../../src/core/service/core-service.js";
import { createLocalUserMemoryControl } from "../../src/local-user-control.js";
import { authority, contributor, evidence, suggested, tempRoot, TestClock, TestIds } from "../helpers.js";
let cleanup: () => void = () => undefined; afterEach(() => cleanup());
it("rejects structurally forged contributor and governance authority", () => {
  const root = tempRoot(); cleanup = root.cleanup;
  const service = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids: new TestIds() }); service.initialize();
  const input = { operation: "add_fact" as const, target_fact_ids: [] as [], suggested_fact: suggested, evidence, reasoning: "明确", confidence: "high" as const };
  expect(service.propose(input, { client: contributor.client, sessionId: contributor.sessionId })).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
  const proposal = service.propose(input, contributor); if (!proposal.ok) throw new Error();
  expect(service.approve({ proposal_id: proposal.data.proposal_id, expected_store_revision: proposal.store_revision! }, { reviewerType: "local_user" })).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
  expect(service.approve({ proposal_id: proposal.data.proposal_id, expected_store_revision: proposal.store_revision! }, authority).ok).toBe(true);
});
it("provides a package-safe nominal local user control path", () => {
  const root = tempRoot(); cleanup = root.cleanup; const service = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids: new TestIds() }); service.initialize(); const control = createLocalUserMemoryControl(service, { sessionId: "session-1" });
  const proposed = control.propose({ operation: "add_fact", target_fact_ids: [], suggested_fact: suggested, evidence, reasoning: "明确", confidence: "high" }); if (!proposed.ok) throw new Error(); expect(control.approve({ proposal_id: proposed.data.proposal_id, expected_store_revision: proposed.store_revision! }).ok).toBe(true);
});
