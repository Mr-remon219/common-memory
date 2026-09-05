import { randomBytes } from "node:crypto";
import type { AnalyzeOptions, ApprovedModelRequest, MemoryModelPort, MemoryModelResult } from "../contracts/model-port.js";
import { MemoryModelError } from "../contracts/errors.js";
import { readBoundedBody } from "./bounded-body.js";
import { decodeResponsesEnvelope } from "./response-decoder.js";
import { defaultRetryPolicy, retryDelay, type RetryPolicy } from "./retry.js";
import { externalPreflight } from "../../core/safety/external-preflight.js";
import { validateDisclosurePolicy, type RemoteDisclosurePolicy } from "../contracts/disclosure.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const MAX_OUTPUT_TOKENS = 16_384; const MAX_RESPONSE_BYTES = 4 * 1_024 * 1_024; const MAX_RETRY_DELAY_MS = 30_000;
export interface OpenAIResponsesMemoryModelOptions {
  apiKey: string; model: string; disclosurePolicy: RemoteDisclosurePolicy; baseUrl?: string; fetch?: typeof fetch; maxOutputTokens?: number; maxResponseBytes?: number;
  fingerprintKey?: string; sleeper?: (ms: number, signal?: AbortSignal) => Promise<void>; jitter?: () => number; retry?: Partial<RetryPolicy>;
}
export class OpenAIResponsesMemoryModel implements MemoryModelPort {
  readonly #apiKey: string; readonly #model: string; readonly #endpoint: string; readonly #policy: RemoteDisclosurePolicy; readonly #fetch: typeof fetch; readonly #maxOutputTokens: number; readonly #maxResponseBytes: number; readonly #fingerprintKey: string;
  readonly #sleeper: (ms: number, signal?: AbortSignal) => Promise<void>; readonly #jitter: () => number; readonly #retry: RetryPolicy;
  constructor(options: OpenAIResponsesMemoryModelOptions) {
    if (!options.apiKey || !options.model) throw new TypeError("apiKey and model are required"); validateDisclosurePolicy(options.disclosurePolicy);
    const maxOutputTokens = options.maxOutputTokens ?? 4_096; const maxResponseBytes = options.maxResponseBytes ?? 1_048_576; const retry = { ...defaultRetryPolicy, ...options.retry };
    requireInteger("maxOutputTokens", maxOutputTokens, 1, MAX_OUTPUT_TOKENS); requireInteger("maxResponseBytes", maxResponseBytes, 1, MAX_RESPONSE_BYTES); requireInteger("retry.maxRetries", retry.maxRetries, 0, 2); requireInteger("retry.baseDelayMs", retry.baseDelayMs, 0, MAX_RETRY_DELAY_MS); requireInteger("retry.maxDelayMs", retry.maxDelayMs, 1, MAX_RETRY_DELAY_MS); if (retry.baseDelayMs > retry.maxDelayMs) throw new TypeError("retry.baseDelayMs cannot exceed retry.maxDelayMs");
    this.#apiKey = options.apiKey; this.#model = options.model; this.#endpoint = `${normalizeOpenAICompatibleBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL)}/responses`; this.#policy = Object.freeze({ ...options.disclosurePolicy, allowedScopes: Object.freeze([...options.disclosurePolicy.allowedScopes]), allowedProvenance: Object.freeze([...options.disclosurePolicy.allowedProvenance]) }); this.#fetch = options.fetch ?? fetch; this.#maxOutputTokens = maxOutputTokens; this.#maxResponseBytes = maxResponseBytes;
    this.#fingerprintKey = options.fingerprintKey ?? randomBytes(32).toString("hex"); this.#sleeper = options.sleeper ?? sleep; this.#jitter = options.jitter ?? Math.random; this.#retry = retry;
  }
  #serialize(request: ApprovedModelRequest): string { const schemaName = request.schemaName ?? "memory_maintenance_v2"; return JSON.stringify({ model: this.#model, store: false, max_output_tokens: this.#maxOutputTokens, input: [{ role: "developer", content: [{ type: "input_text", text: request.prompt }] }, { role: "user", content: [{ type: "input_text", text: JSON.stringify(request.projection) }] }], text: { format: { type: "json_schema", name: schemaName, strict: true, schema: request.schema } } }); }
  serializedRequestBytes(request: ApprovedModelRequest): number { return Buffer.byteLength(this.#serialize(request), "utf8"); }
  async analyze(request: ApprovedModelRequest, options: AnalyzeOptions): Promise<MemoryModelResult> {
    externalPreflight(request.projection, this.#policy);
    const schemaName = request.schemaName ?? "memory_maintenance_v2"; if (!/^[A-Za-z0-9_-]{1,64}$/u.test(schemaName)) throw new TypeError("schemaName must be a safe JSON Schema name");
    const bodyText = this.#serialize(request); const exactBody = JSON.parse(bodyText) as Record<string, unknown>; externalPreflight(exactBody, this.#policy, Buffer.byteLength(bodyText, "utf8"));
    if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) throw new MemoryModelError("TIMEOUT", "Model deadline elapsed", true);
    if (options.signal?.aborted) throw new MemoryModelError("CANCELLED", "Model request was cancelled");
    const deadline = Date.now() + options.deadlineMs;
    for (let attempt = 0;; attempt++) {
      const remaining = deadline - Date.now(); if (remaining <= 0) throw new MemoryModelError("TIMEOUT", "Model deadline elapsed", true);
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(2_147_483_647, Math.ceil(remaining)))); const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await this.#fetch(this.#endpoint, { method: "POST", signal, headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" }, body: bodyText });
      } catch (error) {
        if (options.signal?.aborted) throw new MemoryModelError("CANCELLED", "Model request was cancelled");
        if (timeout.aborted || Date.now() >= deadline) throw new MemoryModelError("TIMEOUT", "Model deadline elapsed", true);
        if (attempt < this.#retry.maxRetries) { await this.#wait(attempt, null, deadline, options.signal); continue; }
        throw new MemoryModelError("UNAVAILABLE", "Provider network request failed", true);
      }
      if (!response.ok) {
        const code = response.status === 401 || response.status === 403 ? "AUTHENTICATION" : response.status === 429 ? "RATE_LIMITED" : response.status >= 500 ? "UNAVAILABLE" : "INVALID_RESPONSE";
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < this.#retry.maxRetries) { try { await response.body?.cancel(); } catch { /* ignore */ } await this.#wait(attempt, response.headers.get("retry-after"), deadline, options.signal); continue; }
        try { await response.body?.cancel(); } catch { /* ignore */ }
        throw new MemoryModelError(code, "Provider request failed", retryable);
      }
      let text: string; try { text = await readBoundedBody(response, this.#maxResponseBytes); } catch (error) { if (options.signal?.aborted) throw new MemoryModelError("CANCELLED", "Model request was cancelled"); if (timeout.aborted || Date.now() >= deadline) throw new MemoryModelError("TIMEOUT", "Model deadline elapsed", true); if (error instanceof MemoryModelError) throw error; throw new MemoryModelError("INVALID_RESPONSE", "Provider response body could not be decoded"); }
      let envelope: unknown; try { envelope = JSON.parse(text); } catch { throw new MemoryModelError("INVALID_RESPONSE", "Provider returned malformed JSON"); }
      return decodeResponsesEnvelope(envelope, this.#fingerprintKey);
    }
  }
  async #wait(attempt: number, retryAfter: string | null, deadline: number, signal?: AbortSignal): Promise<void> {
    const delay = retryDelay(attempt, retryAfter, Date.now(), this.#jitter, this.#retry); if (Date.now() + delay >= deadline) throw new MemoryModelError("TIMEOUT", "Model deadline elapsed", true);
    try { await this.#sleeper(delay, signal); } catch { if (signal?.aborted) throw new MemoryModelError("CANCELLED", "Model request was cancelled"); throw new MemoryModelError("UNAVAILABLE", "Retry wait failed", true); }
  }
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> { return new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true }); }); }
function requireInteger(name: string, value: number, min: number, max: number): void { if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${name} must be an integer between ${min} and ${max}`); }
export function normalizeOpenAICompatibleBaseUrl(value: string): string {
  let url: URL; try { url = new URL(value); } catch { throw new TypeError("baseUrl must be an absolute HTTP(S) URL"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError("baseUrl must use HTTP or HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new TypeError("baseUrl must not contain credentials, query, or fragment");
  url.pathname = url.pathname.replace(/\/+$/u, "");
  if (url.pathname.endsWith("/responses")) throw new TypeError("baseUrl must be the API root, not the /responses endpoint");
  return url.toString().replace(/\/$/u, "");
}
export function createOpenAIResponsesMemoryModel(options: OpenAIResponsesMemoryModelOptions): OpenAIResponsesMemoryModel { return new OpenAIResponsesMemoryModel(options); }
