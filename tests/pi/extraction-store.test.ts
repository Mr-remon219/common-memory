import { afterEach, expect, it } from "vitest";
import { PiExtractionStore } from "../../src/pi-extension/extraction-store.js";
import { tempRoot } from "../helpers.js";

let cleanup = (): void => undefined;
afterEach(() => cleanup());

it("atomically binds a raw capture to a stable Pi entry and enqueues only references", async () => {
  const root = tempRoot(); cleanup = root.cleanup;
  const store = new PiExtractionStore(root.path);
  const raw = "  请记住我默认使用中文交流  \n";
  const actual = raw.trim();
  expect(store.stage({ sessionId: "session-1", parentEntryId: "parent-1", text: raw, scope: "global", source: "interactive", observedAt: "2026-01-01T00:00:00.000Z", nowMs: 1_000 })).not.toBeNull();
  expect(store.acceptLatest("session-1", actual, 1_001)).toBe(true);
  expect(store.confirmNext("session-1", actual, 1_002, 1_003)).toBe(true);
  const jobId = store.finalizeSettled("session-1", [{ entryId: "entry-a1b2c3d4", parentEntryId: "parent-1", text: actual, timestamp: 1_002 }], true, 1_004, 1, 0);
  expect(jobId).toMatch(/^extract_/u);
  const job = store.claim(1_004, 60_000);
  expect(job?.observations).toHaveLength(1);
  const resolved = await store.resolve(job!.observations[0]!);
  expect(resolved).toMatchObject({ text: raw, sessionId: "session-1", reference: "pi-session:session-1:entry-a1b2c3d4", provenance: "user_statement" });
  store.finish(job!, { outcome: "no_op" }, 1_005);
  expect(store.pendingCount()).toBe(0);
  expect((await store.resolve(job!.observations[0]!)).text).toBe(raw);
  await expect(store.resolve({ ...job!.observations[0]!, digest: "sha256:" + "0".repeat(64) })).rejects.toThrow(/integrity/u);
  expect(store.finalizeSettled("session-1", [{ entryId: "entry-a1b2c3d4", parentEntryId: "parent-1", text: actual, timestamp: 1_002 }], true, 1_006, 1, 0)).toBeNull();
  store.close();
});

it("does not let a handled stale input replace the newest accepted prompt", () => {
  const root = tempRoot(); cleanup = root.cleanup;
  const store = new PiExtractionStore(root.path);
  store.stage({ sessionId: "session-1", parentEntryId: null, text: "请记住旧的偏好", scope: "global", source: "interactive", observedAt: "2026-01-01T00:00:00.000Z", nowMs: 1_000 });
  expect(store.acceptLatest("session-1", "extension-generated unrelated prompt", 1_001)).toBe(false);
  store.stage({ sessionId: "session-1", parentEntryId: null, text: "请记住新的偏好", scope: "global", source: "interactive", observedAt: "2026-01-01T00:00:01.000Z", nowMs: 2_000 });
  expect(store.acceptLatest("session-1", "请记住新的偏好", 2_001)).toBe(true);
  expect(store.confirmNext("session-1", "请记住新的偏好", 2_002, 2_003)).toBe(true);
  store.finalizeSettled("session-1", [{ entryId: "entry-new", parentEntryId: null, text: "请记住新的偏好", timestamp: 2_002 }], true, 2_004, 1, 0);
  const job = store.claim(2_004, 60_000);
  expect(job?.observations).toHaveLength(1);
  store.close();
});

it("recovers an expired lease after restart and fences the stale worker", () => {
  const root = tempRoot(); cleanup = root.cleanup;
  let store = new PiExtractionStore(root.path);
  store.stage({ sessionId: "session-1", parentEntryId: null, text: "请记住我的偏好", scope: "global", source: "rpc", observedAt: "2026-01-01T00:00:00.000Z", nowMs: 1_000 });
  store.acceptLatest("session-1", "请记住我的偏好", 1_001);
  store.confirmNext("session-1", "请记住我的偏好", 1_002, 1_003);
  store.finalizeSettled("session-1", [{ entryId: "entry-1", parentEntryId: null, text: "请记住我的偏好", timestamp: 1_002 }], true, 1_004, 1, 0);
  const stale = store.claim(1_004, 100)!;
  store.close();
  store = new PiExtractionStore(root.path);
  expect(store.claim(1_050, 100)).toBeNull();
  const recovered = store.claim(1_104, 100)!;
  expect(recovered.leaseGeneration).toBe(stale.leaseGeneration + 1);
  expect(store.finish(stale, { outcome: "no_op" }, 1_105)).toBe(false);
  expect(store.finish(recovered, { outcome: "no_op" }, 1_106)).toBe(true);
  expect(store.pendingCount()).toBe(0);
  store.close();
});
