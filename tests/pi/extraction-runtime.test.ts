import { afterEach, expect, it, vi } from "vitest";
import type { MemoryRunInput } from "../../src/memory-manager/memory-manager.js";
import { PiExtractionRuntime } from "../../src/pi-extension/extraction-runtime.js";
import { PiExtractionStore } from "../../src/pi-extension/extraction-store.js";
import { tempRoot } from "../helpers.js";

let cleanup = (): void => undefined;
afterEach(() => { vi.useRealTimers(); cleanup(); });

it("captures only eligible settled user statements and runs the extract-only worker", async () => {
  const root = tempRoot(); cleanup = root.cleanup;
  const store = new PiExtractionStore(root.path);
  let nowMs = 1_000;
  const extract = vi.fn(async (_input: MemoryRunInput) => ({ outcome: "no_op" as const }));
  const runtime = new PiExtractionRuntime({ store, managerFactory: () => ({ extract }), allowedScopes: ["global"], now: () => new Date(nowMs), batchSize: 1, idleDelayMs: 0 });
  runtime.start("session-1", []);
  expect(runtime.stageInput({ sessionId: "session-1", parentEntryId: null, text: "实现这个 TypeScript 功能", source: "interactive", hasImages: false })).toBe(false);
  expect(runtime.stageInput({ sessionId: "session-1", parentEntryId: null, text: "请记住这个项目使用 pnpm", source: "interactive", hasImages: false })).toBe(false);
  expect(runtime.stageInput({ sessionId: "session-1", parentEntryId: null, text: "更正：我其实更喜欢英文", source: "interactive", hasImages: false })).toBe(false);
  expect(runtime.stageInput({ sessionId: "session-1", parentEntryId: null, text: "请记住我默认使用中文交流", source: "interactive", streamingBehavior: "followUp", hasImages: false })).toBe(false);
  expect(runtime.stageInput({ sessionId: "session-1", parentEntryId: null, text: "请记住我默认使用中文交流", source: "interactive", hasImages: false })).toBe(true);
  runtime.acceptPrompt("session-1", "请记住我默认使用中文交流");
  runtime.confirmUserMessage("session-1", "请记住我默认使用中文交流", 1_001);
  runtime.recordAgentEnd("session-1", [{ role: "assistant", content: "不会进入 observation", stopReason: "stop" }]);
  nowMs = 1_002;
  runtime.settle("session-1", [{ entryId: "entry-1", parentEntryId: null, text: "请记住我默认使用中文交流", timestamp: 1_001 }]);
  await runtime.runDueOnce();
  expect(extract).toHaveBeenCalledTimes(1);
  const input = extract.mock.calls[0]?.[0];
  expect(input?.observations).toHaveLength(1);
  expect(JSON.stringify(input)).not.toContain("不会进入 observation");
  expect(store.pendingCount()).toBe(0);
  await runtime.shutdown();
});

it("reschedules an idle timer when the batch threshold is reached", async () => {
  vi.useFakeTimers();
  const root = tempRoot(); cleanup = root.cleanup;
  const store = new PiExtractionStore(root.path);
  let nowMs = 1_000;
  const extract = vi.fn(async (_input: MemoryRunInput) => ({ outcome: "no_op" as const }));
  const runtime = new PiExtractionRuntime({ store, managerFactory: () => ({ extract }), allowedScopes: ["global"], now: () => new Date(nowMs), batchSize: 2, idleDelayMs: 60_000 });
  runtime.start("session-1", []);
  for (const [entryId, text, timestamp] of [["entry-1", "请记住我偏好中文", 1_001], ["entry-2", "请记住我偏好简洁", 1_002]] as const) {
    runtime.stageInput({ sessionId: "session-1", parentEntryId: null, text, source: "interactive", hasImages: false });
    runtime.acceptPrompt("session-1", text); runtime.confirmUserMessage("session-1", text, timestamp);
    runtime.recordAgentEnd("session-1", [{ role: "assistant", stopReason: "stop" }]);
    runtime.settle("session-1", [{ entryId, parentEntryId: null, text, timestamp }]); nowMs += 1;
  }
  await vi.runOnlyPendingTimersAsync();
  expect(extract).toHaveBeenCalledTimes(1);
  await runtime.shutdown();
});

it("drops captures from aborted runs and keeps deferred jobs retryable", async () => {
  const root = tempRoot(); cleanup = root.cleanup;
  const store = new PiExtractionStore(root.path);
  let nowMs = 1_000;
  const extract = vi.fn(async (_input: MemoryRunInput) => ({ outcome: "deferred" as const, reason_code: "TIMEOUT" }));
  const runtime = new PiExtractionRuntime({ store, managerFactory: () => ({ extract }), allowedScopes: ["global"], now: () => new Date(nowMs), batchSize: 1, idleDelayMs: 0 });
  runtime.start("session-1", []);
  runtime.stageInput({ sessionId: "session-1", parentEntryId: null, text: "请记住我默认使用中文", source: "rpc", hasImages: false });
  runtime.acceptPrompt("session-1", "请记住我默认使用中文");
  runtime.confirmUserMessage("session-1", "请记住我默认使用中文", 1_001);
  runtime.recordAgentEnd("session-1", [{ role: "assistant", stopReason: "aborted" }]);
  runtime.settle("session-1", [{ entryId: "entry-aborted", parentEntryId: null, text: "请记住我默认使用中文", timestamp: 1_001 }]);
  expect(store.pendingCount()).toBe(0);

  nowMs = 2_000;
  runtime.stageInput({ sessionId: "session-1", parentEntryId: null, text: "请记住我偏好简洁回答", source: "interactive", hasImages: false });
  runtime.acceptPrompt("session-1", "请记住我偏好简洁回答");
  runtime.confirmUserMessage("session-1", "请记住我偏好简洁回答", 2_001);
  runtime.recordAgentEnd("session-1", [{ role: "assistant", stopReason: "stop" }]);
  runtime.settle("session-1", [{ entryId: "entry-ok", parentEntryId: null, text: "请记住我偏好简洁回答", timestamp: 2_001 }]);
  nowMs = 2_002;
  await runtime.runDueOnce();
  expect(store.pendingCount()).toBe(1);
  await runtime.shutdown();
});
