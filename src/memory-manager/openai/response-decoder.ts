import { createHmac } from "node:crypto";
import type { MemoryModelResult, ModelUsage } from "../contracts/model-port.js";
import { MemoryModelError } from "../contracts/errors.js";

export function decodeResponsesEnvelope(value: unknown, fingerprintKey: string): MemoryModelResult {
  const root = record(value);
  if (root.status !== "completed" || (root.incomplete_details !== null && root.incomplete_details !== undefined) || (root.error !== null && root.error !== undefined) || !Array.isArray(root.output)) invalid();
  const messages: Record<string, unknown>[] = [];
  for (const item of root.output) {
    const output = record(item);
    if (output.type === "reasoning") continue;
    if (output.type !== "message") invalid();
    messages.push(output);
  }
  if (messages.length !== 1) invalid();
  const message = messages[0]!;
  if (message.status !== "completed" || message.role !== "assistant" || !Array.isArray(message.content) || message.content.length !== 1) invalid();
  const content = record(message.content[0]); const usage = parseUsage(root.usage);
  if (content.type === "refusal" && typeof content.refusal === "string") return { kind: "refusal", category: "provider_refusal", fingerprint: createHmac("sha256", fingerprintKey).update(content.refusal, "utf8").digest("hex"), usage };
  if (content.type !== "output_text" || typeof content.text !== "string") invalid();
  let body: unknown; try { body = JSON.parse(content.text); } catch { invalid(); }
  return { kind: "output", body, usage };
}
function parseUsage(value: unknown): ModelUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const usage = value as Record<string, unknown>; const out: ModelUsage = {};
  if (finite(usage.input_tokens)) out.inputTokens = usage.input_tokens; if (finite(usage.output_tokens)) out.outputTokens = usage.output_tokens; if (finite(usage.total_tokens)) out.totalTokens = usage.total_tokens;
  return out;
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function invalid(): never { throw new MemoryModelError("INVALID_RESPONSE", "Provider returned an invalid Responses envelope"); }
