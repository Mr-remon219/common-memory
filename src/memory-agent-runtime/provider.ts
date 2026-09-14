import { modelCapability } from './capabilities.js';
export { modelCapability } from './capabilities.js';
import type { Model, Api } from '@earendil-works/pi-ai';
import { stream as responses } from '@earendil-works/pi-ai/api/openai-responses';
import { stream as completions } from '@earendil-works/pi-ai/api/openai-completions';
import type { MemoryTask, MemoryReadPort, MemoryAgentOptions, MemoryAgentRuntime } from '../core/contracts/memory-agent.js';
import { MemoryModelError } from '../core/contracts/errors.js';
import { externalPreflight } from '../core/safety/external-preflight.js';
import { networkFailure } from './network/client.js';
import { cancelBody } from './network/abort.js';
import { withProgressTimeout } from './network/progress.js';
import { httpDiagnostic } from './network/response.js';
import { PiMemoryAgent } from './agent.js';
import { normalizeOpenAICompatibleBaseUrl } from './endpoint.js';
import type { RemoteTuning, RemoteApi } from './options.js';

export interface ProviderOptions extends RemoteTuning {
  api?: RemoteApi; baseUrl: string; model: string; apiKey: string; fetch: typeof fetch;
  maxInputBytes?: number | null;
  /** Deprecated: automatic retries are owned by the Core recovery budget. */
  maxRetries?: number;
  requestTimeoutMs?: number; idleTimeoutMs?: number;
}
export function providerModel(options: Pick<ProviderOptions, 'baseUrl' | 'model' | 'api'>): Model<Api> {
  const known = modelCapability(options).model;
  if (known) return structuredClone(known);
  return { id: options.model, name: options.model, provider: 'common-memory-custom', api: options.api === 'chat_completions' ? 'openai-completions' : 'openai-responses',
    baseUrl: normalizeOpenAICompatibleBaseUrl(options.baseUrl), reasoning: false, input: ['text'], contextWindow: 0, maxTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStrictMode: false, supportsStore: false } };
}
/** Direct API streams deliberately omit maxTokens when Unlimited; streamSimple would invent a cap. */
export class ProviderMemoryAgent implements MemoryAgentRuntime {
  constructor(readonly options: ProviderOptions) {
    if (!options.apiKey || !options.model) throw new TypeError('apiKey and model are required');
  }
  async decide(task: MemoryTask, reads: MemoryReadPort, run: MemoryAgentOptions) {
    let transportError: MemoryModelError | undefined;
    let outboundError: unknown;
    const model = providerModel(this.options);
    const agent = new PiMemoryAgent({ model, ...(this.options.maxAgentTurns === undefined ? {} : { maxAgentTurns: this.options.maxAgentTurns }),
      ...(this.options.reasoningEffort === undefined ? {} : { reasoningEffort: this.options.reasoningEffort }),
      failure: () => outboundError ?? transportError,
      stream: () => (_model, context) => {
        run.signal.throwIfAborted();
        transportError = undefined;
        outboundError = undefined;
        const options = {
          apiKey: this.options.apiKey, signal: run.signal,
          // OpenAI SDK bounds headers only; our shorter detector supplies the diagnostic.
          timeoutMs: (this.options.requestTimeoutMs ?? 30_000) + 1000,
          maxRetries: 0,
          ...(this.options.maxOutputTokens == null ? {} : { maxTokens: this.options.maxOutputTokens }),
          fetch: async (input: string | URL | Request, init?: RequestInit) => {
            run.onDiagnosticContext?.({ stage: 'request' });
            try {
              const requestSignal = AbortSignal.any([run.signal, ...(init?.signal ? [init.signal] : [])]);
              const response = await withProgressTimeout(signal => {
                const pending = this.options.fetch(input, {...init, signal});
                void pending.then(response => { if (signal.aborted) cancelBody(response.body); }, () => {});
                return pending;
              }, requestSignal, this.options.requestTimeoutMs ?? 30_000, 'request');
              run.onDiagnosticContext?.({ stage: response.ok ? 'response_body' : 'http', httpStatus: response.status });
              if (!response.ok) {
                const status = response.status;
                const diagnostic = await httpDiagnostic(response, run.signal);
                transportError = new MemoryModelError(status === 401 || status === 403 ? 'AUTHENTICATION' : status === 429 ? 'RATE_LIMITED' : status >= 500 ? 'UNAVAILABLE' : 'INVALID_RESPONSE', 'Provider request failed', diagnostic.retryable, diagnostic);
                return new Response('{}', { status, headers: response.headers });
              }
              transportError = undefined;
              if (!response.body) return response;
              const reader = response.body.getReader();
              const body = new ReadableStream<Uint8Array>({
                pull: async controller => {
                  try { const chunk = await withProgressTimeout(() => reader.read(), requestSignal, this.options.idleTimeoutMs ?? 120_000, 'response_body'); if (chunk.done) controller.close(); else controller.enqueue(chunk.value); }
                  catch (error) {
                    const mapped = error instanceof MemoryModelError ? error : networkFailure(error, false);
                    transportError = new MemoryModelError(mapped.code, 'Provider stream failed', mapped.retryable, { ...mapped.diagnostic!, stage: 'response_body', httpStatus: response.status });
                    void reader.cancel().catch(() => {}); controller.error(transportError);
                  }
                },
                cancel: () => { void reader.cancel().catch(() => {}); },
              });
              return new Response(body, { status: response.status, headers: response.headers });
            } catch (error) {
              transportError = error instanceof MemoryModelError ? error : networkFailure(error, false); throw transportError;
            }
          },
          onPayload: (payload: unknown) => {
            const body = payload as Record<string, unknown>;
            // Legacy explicitly configured reasoning controls retain their exact wire meanings.
            if (this.options.api === 'chat_completions') {
              if (this.options.reasoningEffort !== undefined) body.reasoning_effort = this.options.reasoningEffort;
              if (this.options.thinking !== undefined) body.thinking = this.options.thinking;
              if (this.options.enableThinking !== undefined) body.enable_thinking = this.options.enableThinking;
            } else {
              body.store = false;
              // Pi clamps Responses values below 16; an explicit operator cap must not be increased.
              if (this.options.maxOutputTokens != null) body.max_output_tokens = this.options.maxOutputTokens;
              if (this.options.reasoningEffort !== undefined) body.reasoning = { effort: this.options.reasoningEffort };
            }
            const cap = this.options.maxInputBytes ?? Number.MAX_SAFE_INTEGER;
            try { externalPreflight(body, { maxExcerptBytes: cap, maxCandidateBytes: cap, maxTotalBytes: cap }); }
            catch (error) { outboundError = error; throw error; }
            return body;
          },
        };
        return this.options.api === 'chat_completions' ? completions(model as Model<'openai-completions'>, context, options) : responses(model as Model<'openai-responses'>, context, options);
      },
    });
    try { return await agent.decide(task, reads, run); }
    catch (error) { if (run.signal.aborted) throw run.signal.reason; throw outboundError ?? transportError ?? error; }
  }
}
