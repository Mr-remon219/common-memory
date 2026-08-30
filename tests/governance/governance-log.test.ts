import { afterEach, expect, it } from "vitest";
import { CoreService } from "../../src/core/service/core-service.js";
import { createLocalUserMemoryControl } from "../../src/local-user-control.js";
import type { IdGenerator } from "../../src/core/contracts/ports.js";
import { evidence, suggested, tempRoot, TestClock } from "../helpers.js";
let cleanup: () => void = () => undefined; afterEach(() => cleanup());
class MixedCaseIds implements IdGenerator { count = 0; proposal = 0; next(prefix: "fact" | "proposal" | "review" | "repository" | "transaction"): string { if (prefix === "proposal") return ["proposal.aaaaaaaa", "proposal.BBBBBBBB"][this.proposal++]!; return `${prefix}.${String(++this.count).padStart(8, "0")}`; } }
it("uses one bytewise ordering for mixed-case governance cursors", () => {
  const root = tempRoot(); cleanup = root.cleanup; const core = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids: new MixedCaseIds() }); core.initialize(); const control = createLocalUserMemoryControl(core, { sessionId: "session-1" }); for (const statement of ["a", "b"]) { const result = control.propose({ operation: "add_fact", target_fact_ids: [], suggested_fact: { ...suggested, statement }, evidence, reasoning: statement, confidence: "high" }); if (!result.ok) throw new Error(); }
  const first = core.listGovernance({ limit: 1 }); if (!first.ok || !first.data.next_cursor) throw new Error(); const second = core.listGovernance({ limit: 1, cursor: first.data.next_cursor }); if (!second.ok) throw new Error(); expect([first.data.items[0]!.proposal.id, second.data.items[0]!.proposal.id]).toEqual(["proposal.BBBBBBBB", "proposal.aaaaaaaa"]);
});
