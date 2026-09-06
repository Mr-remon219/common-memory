import { expect, it, vi } from "vitest";
import { OpenAIResponsesMemoryModel } from "../../src/memory-manager/openai/openai-responses-adapter.js";
const request = { prompt: "fixed", projection: {}, schema: { type: "object", additionalProperties: false, required: [], properties: {} } };
const disclosurePolicy = { enabled: true as const, allowedScopes: ["global"], allowedProvenance: ["user_explicit" as const], maxExcerptBytes: 1000, maxCandidateBytes: 1000, maxTotalBytes: 5000 };
it("retries 429 twice but never retries authentication failures", async () => {
  const sleeper = vi.fn(async () => undefined); const limited = vi.fn(async () => new Response("secret provider body", { status: 429, headers: { "retry-after": "0" } }));
  const adapter = new OpenAIResponsesMemoryModel({ disclosurePolicy, apiKey: "key", model: "model", fetch: limited, sleeper, jitter: () => 0 });
  await expect(adapter.analyze(request, { requestId: "req_12345678", deadlineMs: 1000 })).rejects.toMatchObject({ code: "RATE_LIMITED" }); expect(limited).toHaveBeenCalledTimes(3);
  const denied = vi.fn(async () => new Response("secret provider body", { status: 401 })); const auth = new OpenAIResponsesMemoryModel({ disclosurePolicy, apiKey: "key", model: "model", fetch: denied });
  await expect(auth.analyze(request, { requestId: "req_12345678", deadlineMs: 1000 })).rejects.toMatchObject({ code: "AUTHENTICATION" }); expect(denied).toHaveBeenCalledTimes(1);
});
it.each([
  ["5xx", async () => new Response("body", { status: 503 }), "UNAVAILABLE"],
  ["network", async () => { throw new Error("network detail"); }, "UNAVAILABLE"]
] as const)("retries %s failures exactly twice", async (_name, fetchImpl, code) => {
  const fetchMock = vi.fn(fetchImpl); const adapter = new OpenAIResponsesMemoryModel({ disclosurePolicy, apiKey: "key", model: "model", fetch: fetchMock, sleeper: async () => undefined }); await expect(adapter.analyze(request, { requestId: "req_12345678", deadlineMs: 1000 })).rejects.toMatchObject({ code }); expect(fetchMock).toHaveBeenCalledTimes(3);
});
it("cancels during retry wait without another fetch", async () => {
  const controller = new AbortController(); const fetchImpl = vi.fn(async () => new Response("body", { status: 429 })); const sleeper = vi.fn(async (_ms: number, signal?: AbortSignal) => await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))); const adapter = new OpenAIResponsesMemoryModel({ disclosurePolicy, apiKey: "key", model: "model", fetch: fetchImpl, sleeper }); const pending = adapter.analyze(request, { requestId: "req_12345678", signal: controller.signal, deadlineMs: 1000 }); await vi.waitFor(() => expect(sleeper).toHaveBeenCalledOnce()); controller.abort(); await expect(pending).rejects.toMatchObject({ code: "CANCELLED" }); expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it("classifies explicit cancellation separately from deadline timeout", async () => {
  const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })));
  const timeoutAdapter = new OpenAIResponsesMemoryModel({ disclosurePolicy, apiKey: "key", model: "model", fetch: fetchImpl }); await expect(timeoutAdapter.analyze(request, { requestId: "req_12345678", deadlineMs: 5 })).rejects.toMatchObject({ code: "TIMEOUT" });
  const controller = new AbortController(); const adapter = new OpenAIResponsesMemoryModel({ disclosurePolicy, apiKey: "key", model: "model", fetch: fetchImpl }); const pending = adapter.analyze(request, { requestId: "req_12345678", signal: controller.signal, deadlineMs: 1000 }); controller.abort(); await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
});
