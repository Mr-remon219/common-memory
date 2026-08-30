import { afterEach, expect, it } from "vitest";
import { CoreService } from "../../src/core/service/core-service.js";
import { authority, contributor, evidence, suggested, tempRoot, TestClock, TestIds } from "../helpers.js";
let cleanup: () => void = () => undefined; afterEach(() => cleanup());
it("undoes an add with one idempotent compensation batch and no deletion", () => {
  const root = tempRoot(); cleanup = root.cleanup; const service = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids: new TestIds() }); service.initialize();
  const proposed = service.propose({ operation: "add_fact", target_fact_ids: [], suggested_fact: { ...suggested, priority: "normal" }, evidence, reasoning: "x", confidence: "high" }, contributor); if (!proposed.ok) throw new Error();
  const approved = service.approve({ proposal_id: proposed.data.proposal_id, expected_store_revision: proposed.store_revision! }, authority); if (!approved.ok) throw new Error();
  const preview = service.previewUndo({ review_ids: [approved.data.review.id] }); if (!preview.ok) throw new Error(JSON.stringify(preview.error));
  const applied = service.applyUndo({ preview: preview.data }, authority); if (!applied.ok) throw new Error(JSON.stringify(applied.error)); expect(applied.data.idempotent).toBe(false);
  const again = service.applyUndo({ preview: preview.data }, authority); expect(again.ok && again.data.idempotent).toBe(true);
  const current = service.get({ scopes: ["global"] }); expect(current.ok && current.data.facts).toHaveLength(0);
  const history = service.get({ scopes: ["global"], include_history: true }); if (!history.ok) throw new Error(); expect(history.data.facts.some((fact) => fact.status === "deleted")).toBe(false);
});
