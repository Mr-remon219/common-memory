import { afterEach, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryManagerJobStore } from "../../src/memory-manager/scheduler/job-store.js";
import { tempRoot } from "../helpers.js";
let cleanup: () => void = () => undefined; afterEach(() => cleanup());
it("persists only references and sanitized run state", () => {
  const root = tempRoot(); cleanup = root.cleanup; const store = new MemoryManagerJobStore(root.path); const now = Date.now();
  store.enqueue({ jobId: "job.12345678", repositoryId: "repository.12345678", scope: "global", trigger: "manual", checkpoint: null, observations: [{ observationId: "o1", digest: `sha256:${"2".repeat(64)}`, scope: "global", provenance: "user_statement" }], availableAt: now }, now);
  const job = store.claim(now, 1000); expect(job?.observations[0]?.observationId).toBe("o1"); if (!job) throw new Error(); store.finish(job, "no_op", {}, now); expect(store.pendingCount()).toBe(0);
  expect(() => store.enqueue({ jobId: "job.secret", repositoryId: "repository.12345678", scope: "global", trigger: "manual", checkpoint: null, observations: [{ observationId: "o2", digest: `sha256:${"5".repeat(64)}`, scope: "global", provenance: "user_statement", text: "raw transcript secret" } as never], availableAt: now }, now)).toThrow(); store.close();
  const db = join(root.path, "memory-manager.sqlite"); expect(existsSync(db)).toBe(true); expect(readFileSync(db).toString("utf8")).not.toContain("raw transcript secret");
});
it("fences a worker whose lease expired and was reclaimed", () => {
  const root = tempRoot(); cleanup = root.cleanup; const store = new MemoryManagerJobStore(root.path); const now = 1_000;
  store.enqueue({ jobId: "job.lease-fence", repositoryId: "repository.12345678", scope: "global", trigger: "manual", checkpoint: null, observations: [], availableAt: now }, now);
  const first = store.claim(now, 10); const second = store.claim(now + 11, 10); if (!first || !second) throw new Error();
  expect(first.leaseToken).not.toBe(second.leaseToken); expect(store.finish(first, "committed", {}, now + 12)).toBe(false); expect(store.pendingCount()).toBe(1);
  expect(store.finish(second, "committed", {}, now + 13)).toBe(true); expect(store.pendingCount()).toBe(0); store.close();
});
