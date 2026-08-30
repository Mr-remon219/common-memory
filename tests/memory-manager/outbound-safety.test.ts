import { afterEach, expect, it, vi } from "vitest";
import { CoreService } from "../../src/core/service/core-service.js";
import { MemoryManager } from "../../src/memory-manager/memory-manager.js";
import { digestText } from "../../src/memory-manager/retrieval.js";
import { tempRoot, TestClock, TestIds } from "../helpers.js";
let cleanup: () => void = () => undefined; afterEach(() => cleanup());
it.each(["api_key: sk-abcdefghijklmnopqrstuvwxyz", "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"])("blocks sensitive outbound excerpt %s before invoking the model", async (text) => {
  const root = tempRoot(); cleanup = root.cleanup; const core = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids: new TestIds() }); core.initialize();
  const analyze = vi.fn();
  const manager = new MemoryManager({ core, model: { analyze }, observations: { resolve: async (reference) => ({ ...reference, text, observedAt: "2026-01-01T00:00:00.000Z", sessionId: "s", reference: "m" }) }, disclosurePolicy: { enabled: true, allowedScopes: ["global"], allowedProvenance: ["user_statement"], maxExcerptBytes: 1000, maxCandidateBytes: 1000, maxTotalBytes: 5000 } });
  const result = await manager.extract({ observations: [{ observationId: "o1", digest: digestText(text), scope: "global", provenance: "user_statement" }] });
  expect(result).toMatchObject({ outcome: "blocked" }); expect(analyze).not.toHaveBeenCalled();
});
