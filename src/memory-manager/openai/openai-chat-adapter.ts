import { createHmac } from 'node:crypto';
import type { ApprovedModelRequest, MemoryModelResult } from '../contracts/model-port.js';
import { MemoryModelError } from '../contracts/errors.js';
import type { DiagnosticReason } from '../contracts/diagnostic.js';
import { RemoteHttpMemoryModel, type RemoteHttpOptions } from './remote-http.js';
import { validateRemoteTuning, type RemoteTuning } from './options.js';
export interface OpenAIChatMemoryModelOptions extends RemoteHttpOptions { thinking?: {type:'enabled' | 'disabled'}; enableThinking?: boolean }
export class OpenAIChatMemoryModel extends RemoteHttpMemoryModel {
  readonly #tuning: RemoteTuning;
  constructor(options: OpenAIChatMemoryModelOptions) { super(options, 'chat/completions'); this.#tuning = validateRemoteTuning(options, 'chat_completions'); }
  protected serialize(request: ApprovedModelRequest): string {
    return JSON.stringify({model:this.model,max_tokens:this.maxOutputTokens,messages:[
      {role:'system',content:`${request.prompt}\n\nReturn one JSON object conforming to this complete JSON Schema (${request.schemaName ?? 'memory_maintenance_v2'}):\n${JSON.stringify(request.schema)}`},
      {role:'user',content:JSON.stringify(request.projection)},
    ],response_format:{type:'json_object'},...(this.#tuning.thinking === undefined ? {} : {thinking:this.#tuning.thinking}),...(this.#tuning.enableThinking === undefined ? {} : {enable_thinking:this.#tuning.enableThinking})});
  }
  protected decode(envelope: unknown, fingerprintKey: string): MemoryModelResult { return decodeChatEnvelope(envelope, fingerprintKey); }
}
export function decodeChatEnvelope(value: unknown, fingerprintKey: string): MemoryModelResult {
  const root = record(value);
  if (root.error != null || !Array.isArray(root.choices) || root.choices.length !== 1) invalid();
  const choice = record(root.choices[0]);
  if (choice.finish_reason === 'length') invalid('output_truncated');
  if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') invalid('tool_call');
  if (choice.finish_reason !== 'stop') invalid('incomplete_output');
  const message = record(choice.message);
  if (message.role !== 'assistant') invalid();
  if (message.function_call != null || message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0)) invalid('tool_call');
  const u = root.usage && typeof root.usage === 'object' && !Array.isArray(root.usage) ? root.usage as Record<string, unknown> : {};
  const usage = {...(finite(u.prompt_tokens) ? {inputTokens:u.prompt_tokens} : {}),...(finite(u.completion_tokens) ? {outputTokens:u.completion_tokens} : {}),...(finite(u.total_tokens) ? {totalTokens:u.total_tokens} : {})};
  if (typeof message.refusal === 'string' && message.refusal) return {kind:'refusal',category:'provider_refusal',fingerprint:createHmac('sha256',fingerprintKey).update(message.refusal,'utf8').digest('hex'),usage};
  if (message.refusal != null && message.refusal !== '' || typeof message.content !== 'string') invalid();
  let body: unknown; try { body = JSON.parse(message.content); } catch { invalid('invalid_json'); }
  return {kind:'output',body,usage};
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function invalid(reason: DiagnosticReason = 'invalid_envelope'): never { throw new MemoryModelError('INVALID_RESPONSE','Provider returned an invalid Chat envelope',false,{stage:reason === 'invalid_json' ? 'model_output' : 'response_envelope',reason,retryable:false}); }
