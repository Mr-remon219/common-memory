import { afterEach, expect, it } from "vitest";
import type { MemoryManager } from "../../src/memory-manager/memory-manager.js";
import { sourceDigest } from "../../src/core/governance/governance-digest.js";
import { MemoryManagerJobStore } from "../../src/memory-manager/scheduler/job-store.js";
import { MemoryManagerScheduler } from "../../src/memory-manager/scheduler/scheduler.js";
import { tempRoot } from "../helpers.js";
let cleanup: () => void = () => undefined; afterEach(() => cleanup());
it("keeps STALE_REVISION jobs retryable", async () => {
  const root = tempRoot(); cleanup = root.cleanup; const store = new MemoryManagerJobStore(root.path); const clock = { now: () => new Date(1_000) }; const manager = { consolidate: async () => ({ outcome: "deferred", reason_code: "STALE_REVISION" }) } as unknown as MemoryManager; const scheduler = new MemoryManagerScheduler({ manager, store, clock });
  scheduler.enqueue({ repositoryId: "repository.12345678", scope: "global", origin: "manual", observations: [] }); expect((await scheduler.runOnce())?.reason_code).toBe("STALE_REVISION"); expect(store.pendingCount()).toBe(1); store.close();
});
it("keeps provenance-distinct observations when coalescing", () => {
  const root = tempRoot(); cleanup = root.cleanup; const store = new MemoryManagerJobStore(root.path); const clock = { now: () => new Date(1_000) }; const manager = { consolidate: async () => ({ outcome: "no_op" }) } as unknown as MemoryManager; const scheduler = new MemoryManagerScheduler({ manager, store, clock }); const base = { observationId: "o1", digest: `sha256:${"8".repeat(64)}`, scope: "global" }; expect(sourceDigest([{ observation_id: base.observationId, observation_digest: base.digest, scope: base.scope, provenance: "user_statement" }])).not.toBe(sourceDigest([{ observation_id: base.observationId, observation_digest: base.digest, scope: base.scope, provenance: "user_correction" }]));
  scheduler.enqueue({ repositoryId: "repository.12345678", scope: "global", origin: "manual", observations: [{ ...base, provenance: "user_statement" }] }); scheduler.enqueue({ repositoryId: "repository.12345678", scope: "global", origin: "manual", observations: [{ ...base, provenance: "user_correction" }] }); const job = store.claim(1_000, 1_000); expect(job?.observations.map((item) => item.provenance).sort()).toEqual(["user_correction", "user_statement"]); store.close();
});
