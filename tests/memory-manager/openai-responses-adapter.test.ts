import { describe, expect, it, vi } from "vitest";
import { OpenAIResponsesMemoryModel } from "../../src/memory-manager/openai/openai-responses-adapter.js";

const request = { prompt: "fixed", projection: { request_id: "req_12345678", excerpts: [] }, schema: { type: "object", additionalProperties: false, required: [], properties: {} } } as const;
const disclosurePolicy = { enabled: true as const, allowedScopes: ["global"], allowedProvenance: ["user_statement" as const], maxExcerptBytes: 1000, maxCandidateBytes: 1000, maxTotalBytes: 5000 };
const envelope = (content: unknown[]) => ({ status: "completed", incomplete_details: null, error: null, output: [{ type: "reasoning", id: "r1", summary: [] }, { type: "message", status: "completed", role: "assistant", content }], usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } });

describe("OpenAI Responses native fetch adapter", () => {
  it("posts strict schema with store false and keeps the key in the header", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(envelope([{ type: "output_text", text: "{\"ok\":true}", annotations: [] }])), { status: 200, headers: { "content-type": "application/json" } }));
    const adapter = new OpenAIResponsesMemoryModel({ disclosurePolicy, apiKey: "sk-test-secret-value", model: "gpt-test", fetch: fetchImpl });
    const result = await adapter.analyze(request, { requestId: "req_12345678", deadlineMs: 1000 });
    expect(result.kind).toBe("output");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(String(init?.body));
    expect(body.store).toBe(false);
    expect(body.text.format).toMatchObject({ type: "json_schema", name: "memory_analysis_v1", strict: true });
    expect(JSON.stringify(body)).not.toContain("sk-test-secret-value");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-test-secret-value");
  });
  it("returns a fingerprinted refusal without retaining refusal text", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(envelope([{ type: "refusal", refusal: "private refusal detail" }])), { status: 200 }));
    const adapter = new OpenAIResponsesMemoryModel({ disclosurePolicy, apiKey: "key", model: "gpt-test", fetch: fetchImpl, fingerprintKey: "test-process-key" });
    const result = await adapter.analyze(request, { requestId: "req_12345678", deadlineMs: 1000 });
    expect(result.kind).toBe("refusal");
    expect(JSON.stringify(result)).not.toContain("private refusal detail");
  });
  it.each([
    ["model", { model: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" }],
    ["schema", { schema: { type: "object", properties: { "api_key: sk-proj-abcdefghijklmnopqrstuvwxyz0123456789": { type: "string" } } } }],
    ["projection-key", { projection: { "api_key: sk-proj-abcdefghijklmnopqrstuvwxyz0123456789": "x" } }]
  ])("scans caller-controlled %s in the exact wire body", async (_case, rawOverride) => {
    const override = rawOverride as { model?: string; schema?: Readonly<Record<string, unknown>>; projection?: Readonly<Record<string, unknown>> }; const fetchImpl = vi.fn(); const adapter = new OpenAIResponsesMemoryModel({ disclosurePolicy, apiKey: "key", model: override.model ?? "gpt-test", fetch: fetchImpl });
    await expect(adapter.analyze({ ...request, ...(override.schema ? { schema: override.schema } : {}), ...(override.projection ? { projection: override.projection } : {}) }, { requestId: "req_12345678", deadlineMs: 1000 })).rejects.toMatchObject({ code: "SENSITIVE_CONTENT_REJECTED" }); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects configuration that disables hard output, body, or retry limits", () => {
    for (const override of [{ maxResponseBytes: Infinity }, { maxResponseBytes: -1 }, { maxOutputTokens: 16_385 }, { retry: { maxRetries: 3 } }]) expect(() => new OpenAIResponsesMemoryModel({ disclosurePolicy, apiKey: "key", model: "gpt-test", ...override })).toThrow();
  });
  it("blocks direct sensitive adapter input before fetch", async () => {
    const fetchImpl = vi.fn(); const adapter = new OpenAIResponsesMemoryModel({ disclosurePolicy, apiKey: "key", model: "gpt-test", fetch: fetchImpl });
    await expect(adapter.analyze({ ...request, projection: { request_id: "req_12345678", excerpts: [{ text: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" }] } }, { requestId: "req_12345678", deadlineMs: 1000 })).rejects.toMatchObject({ code: "SENSITIVE_CONTENT_REJECTED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    "not-json",
    JSON.stringify(envelope([{ type: "output_text", text: "not-json", annotations: [] }]))
  ])("fails closed for malformed HTTP/output JSON", async (body) => {
    const adapter = new OpenAIResponsesMemoryModel({ disclosurePolicy, apiKey: "key", model: "gpt-test", fetch: async () => new Response(body, { status: 200 }) });
    await expect(adapter.analyze(request, { requestId: "req_12345678", deadlineMs: 1000 })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("fails closed for tool output and never exposes the response body", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ...envelope([]), output: [{ type: "function_call", name: "x" }] }), { status: 200 }));
    const adapter = new OpenAIResponsesMemoryModel({ disclosurePolicy, apiKey: "key", model: "gpt-test", fetch: fetchImpl });
    await expect(adapter.analyze(request, { requestId: "req_12345678", deadlineMs: 1000 })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
