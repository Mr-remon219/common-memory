import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RecallResult } from "../../src/recall/contracts.js";
import { createCommonMemoryPiExtension, type MemoryRecallDetails } from "../../src/pi-extension/index.js";
import type { PiExtractionLifecycle } from "../../src/pi-extension/extraction-runtime.js";

interface RegisteredTool {
  name: string;
  parameters: { additionalProperties?: boolean; properties?: Record<string, unknown> };
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: MemoryRecallDetails }>;
}

function result(): RecallResult {
  const revision = `sha256:${"a".repeat(64)}` as const;
  return {
    contract_version: "recall_result_v1",
    request_id: "recall_test_0001",
    mode: "algorithm",
    queries: ["沟通偏好"],
    rrf_k: 60,
    index_revision: revision,
    route: { status: "model", warning: null, reason: "enough" },
    warnings: [],
    usage: {},
    pack: {
      knowledge_revision: revision,
      evaluated_at: "2026-01-01T00:00:00.000Z",
      valid_until: null,
      boundaries: [],
      core: [{ id: "fact.abcdefgh", statement: "用户默认使用中文", kind: "preference", scope: { type: "global", id: null }, validity: { valid_from: "2026-01-01T00:00:00.000Z", expires_at: null, supersedes: [] }, source: { type: "user_statement", source_client: "local_user", reference: "message-1" }, reason: "deterministic-core" }],
      relevant: [],
      historical: [],
      warnings: [],
      degraded: false,
    },
  };
}

type Hook = (event: Record<string, unknown>, context: Record<string, unknown>) => unknown;
function capture(runtimeResult = result(), extraction?: PiExtractionLifecycle): { tool: RegisteredTool; recall: ReturnType<typeof vi.fn>; hooks: Map<string, Hook> } {
  let tool: RegisteredTool | undefined;
  const hooks = new Map<string, Hook>();
  const recall = vi.fn(async () => runtimeResult);
  const pi = { registerTool(value: RegisteredTool) { tool = value; }, on(name: string, handler: Hook) { hooks.set(name, handler); } };
  createCommonMemoryPiExtension({ runtimeFactory: () => ({ recall }), extractionRuntimeFactory: () => extraction ?? null })(pi as unknown as ExtensionAPI);
  if (!tool) throw new Error("tool was not registered");
  return { tool, recall, hooks };
}

describe("Pi memory_recall extension", () => {
  it("registers exactly one read-only tool with a closed input schema", () => {
    const { tool } = capture();
    expect(tool.name).toBe("memory_recall");
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(tool.parameters.properties).toHaveProperty("query");
    expect(tool.parameters.properties).not.toHaveProperty("write");
    expect(tool.parameters.properties).not.toHaveProperty("approve");
  });

  it("calls the shared runtime and forwards the exact Pi AbortSignal", async () => {
    const { tool, recall } = capture(); const controller = new AbortController();
    const output = await tool.execute("call-1", { query: "沟通偏好" }, controller.signal, undefined, {});
    expect(recall).toHaveBeenCalledWith(expect.objectContaining({ query: "沟通偏好", scopes: ["global"], max_context_bytes: 12_000 }), { signal: controller.signal });
    expect(output.content[0]?.text).toContain("用户默认使用中文");
    expect(output.details).toMatchObject({ status: "ok", knowledge_revision: result().pack.knowledge_revision, fact_ids: ["fact.abcdefgh"] });
    expect(output.details.pack_digest).toMatch(/^sha256:/u);
  });

  it("wires raw-input capture to settled extraction without forwarding assistant content", async () => {
    const lifecycle = {
      start: vi.fn(), stageInput: vi.fn(), acceptPrompt: vi.fn(), confirmUserMessage: vi.fn(), recordAgentEnd: vi.fn(), settle: vi.fn(), shutdown: vi.fn(async () => undefined),
    } satisfies PiExtractionLifecycle;
    const { hooks } = capture(result(), lifecycle);
    expect([...hooks.keys()].sort()).toEqual(["agent_end", "agent_settled", "before_agent_start", "input", "message_end", "session_shutdown", "session_start"]);
    const branch = [{ type: "message", id: "entry-1", parentId: "leaf-1", message: { role: "user", content: "请记住我的偏好", timestamp: 10 } }, { type: "message", id: "entry-2", message: { role: "assistant", content: "private assistant text", stopReason: "stop", timestamp: 11 } }];
    const sessionManager = { getSessionId: () => "session-1", getLeafId: () => "leaf-1", getBranch: () => branch };
    const context = { sessionManager } as unknown as Record<string, unknown>;
    await hooks.get("input")?.({ text: "请记住我的偏好", source: "interactive", images: [] }, context);
    await hooks.get("before_agent_start")?.({ prompt: "请记住我的偏好" }, context);
    await hooks.get("message_end")?.({ message: { role: "user", content: "请记住我的偏好", timestamp: 10 } }, context);
    await hooks.get("agent_end")?.({ messages: [{ role: "assistant", content: "private assistant text", stopReason: "stop" }] }, context);
    await hooks.get("agent_settled")?.({}, context);
    expect(lifecycle.stageInput).toHaveBeenCalledWith(expect.objectContaining({ text: "请记住我的偏好", source: "interactive" }));
    expect(lifecycle.confirmUserMessage).toHaveBeenCalledWith("session-1", "请记住我的偏好", 10);
    expect(lifecycle.recordAgentEnd).toHaveBeenCalledWith("session-1", expect.any(Array));
    expect(lifecycle.settle).toHaveBeenCalledWith("session-1", [{ entryId: "entry-1", parentEntryId: "leaf-1", text: "请记住我的偏好", timestamp: 10 }]);
    expect(JSON.stringify(lifecycle.settle.mock.calls)).not.toContain("private assistant text");
  });
});
