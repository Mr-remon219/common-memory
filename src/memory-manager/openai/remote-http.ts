import { NetworkClient, networkFailure } from "../network/client.js";
import { randomBytes } from 'node:crypto';
import type { AnalyzeOptions, ApprovedModelRequest, MemoryModelPort, MemoryModelResult } from '../contracts/model-port.js';
import { MemoryModelError, type MemoryModelErrorCode } from '../contracts/errors.js';
import type { DiagnosticReason, DiagnosticStage, FailureDiagnostic } from '../contracts/diagnostic.js';
import { validateDisclosurePolicy, type RemoteDisclosurePolicy } from '../contracts/disclosure.js';
import { externalPreflight } from '../../core/safety/external-preflight.js';
import { readBoundedBody } from './bounded-body.js';
import { abortable, cancelBody } from './abort.js';
import { defaultRetryPolicy, retryDelay, type RetryPolicy } from './retry.js';

export interface RemoteHttpOptions {
  network?: NetworkClient;
  apiKey: string; model: string; disclosurePolicy: RemoteDisclosurePolicy; baseUrl?: string; fetch?: typeof fetch; maxOutputTokens?: number; maxResponseBytes?: number;
  fingerprintKey?: string; sleeper?: (ms: number, signal?: AbortSignal) => Promise<void>; jitter?: () => number; retry?: Partial<RetryPolicy>;
}
/** Shared, bounded transport. Each API has an explicit serializer and fail-closed decoder. */
export abstract class RemoteHttpMemoryModel implements MemoryModelPort {
  protected readonly model: string; protected readonly maxOutputTokens: number;
  readonly #network: NetworkClient | undefined;
  readonly #abort = new AbortController();
  #closing: Promise<void> | undefined;
  readonly #apiKey: string; readonly #endpoint: string; readonly #policy: RemoteDisclosurePolicy; readonly #fetch: typeof fetch; readonly #maxResponseBytes: number; readonly #fingerprintKey: string;
  readonly #sleeper: (ms: number, signal?: AbortSignal) => Promise<void>; readonly #jitter: () => number; readonly #retry: RetryPolicy;
  constructor(options: RemoteHttpOptions, endpoint: 'responses' | 'chat/completions') {
    if (!options.apiKey || !options.model) throw new TypeError('apiKey and model are required');
    validateDisclosurePolicy(options.disclosurePolicy);
    const retry = {...defaultRetryPolicy, ...options.retry};
    this.maxOutputTokens = options.maxOutputTokens ?? 4096; this.#maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
    requireInteger('maxOutputTokens', this.maxOutputTokens, 1, 16384); requireInteger('maxResponseBytes', this.#maxResponseBytes, 1, 4 * 1024 * 1024);
    requireInteger('retry.maxRetries', retry.maxRetries, 0, 2); requireInteger('retry.baseDelayMs', retry.baseDelayMs, 0, 30000); requireInteger('retry.maxDelayMs', retry.maxDelayMs, 1, 30000);
    if (retry.baseDelayMs > retry.maxDelayMs) throw new TypeError('retry.baseDelayMs cannot exceed retry.maxDelayMs');
    this.#apiKey = options.apiKey; this.model = options.model; this.#endpoint = `${normalizeOpenAICompatibleBaseUrl(options.baseUrl ?? 'https://api.openai.com/v1')}/${endpoint}`;
    this.#policy = Object.freeze({...options.disclosurePolicy, allowedScopes: Object.freeze([...options.disclosurePolicy.allowedScopes]), allowedProvenance: Object.freeze([...options.disclosurePolicy.allowedProvenance])});
    if (options.fetch && options.network) throw new TypeError("fetch and network are mutually exclusive");
    this.#network = options.network;
    this.#fetch = options.fetch ?? options.network?.fetch ?? fetch; this.#fingerprintKey = options.fingerprintKey ?? randomBytes(32).toString('hex'); this.#sleeper = options.sleeper ?? sleep; this.#jitter = options.jitter ?? Math.random; this.#retry = retry;
  }
  close(): Promise<void> {
    this.#abort.abort();
    return this.#closing ??= this.#network?.close() ?? Promise.resolve();
  }
  protected abstract serialize(request: ApprovedModelRequest): string;
  protected abstract decode(envelope: unknown, fingerprintKey: string): MemoryModelResult;
  serializedRequestBytes(request: ApprovedModelRequest): number { return Buffer.byteLength(this.serialize(request), 'utf8'); }
  async analyze(request: ApprovedModelRequest, options: AnalyzeOptions): Promise<MemoryModelResult> {
    options.onDiagnosticContext?.({stage:'request'});
    externalPreflight(request.projection, this.#policy);
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(request.schemaName ?? 'memory_maintenance_v2')) throw new TypeError('schemaName must be a safe JSON Schema name');
    const bodyText = this.serialize(request);
    externalPreflight(JSON.parse(bodyText) as Record<string, unknown>, this.#policy, Buffer.byteLength(bodyText, 'utf8'));
    if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) throw failure('TIMEOUT', 'request', 'timeout', true);
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(2_147_483_647, Math.ceil(options.deadlineMs))));
    const signal = AbortSignal.any([this.#abort.signal, timeout, ...(options.signal ? [options.signal] : [])]);
    const deadline = Date.now() + options.deadlineMs;
    const terminated = (stage: DiagnosticStage, httpStatus?: number): MemoryModelError => failure(signal.reason === timeout.reason && timeout.aborted ? 'TIMEOUT' : 'CANCELLED', stage, signal.reason === timeout.reason && timeout.aborted ? 'timeout' : 'cancelled', signal.reason === timeout.reason && timeout.aborted, httpStatus);
    for (let attempt = 0;; attempt++) {
      if (signal.aborted) throw terminated('request');
      options.onDiagnosticContext?.({stage:'request'});
      let response: Response;
      try {
        const pending = this.#fetch(this.#endpoint, {method: 'POST', signal, headers: {authorization: `Bearer ${this.#apiKey}`, 'content-type': 'application/json'}, body: bodyText});
        void pending.then(late => { if (signal.aborted) cancelBody(late.body); }, () => {});
        response = await abortable(pending, signal);
      } catch (error) {
        if (signal.aborted) throw terminated('request');
        const mapped = error instanceof MemoryModelError ? error : networkFailure(error, false);
        if (mapped.retryable && attempt < this.#retry.maxRetries) { await this.#wait(attempt, null, deadline, signal, terminated); continue; }
        throw mapped;
      }
      options.onDiagnosticContext?.({stage:response.ok ? 'response_body' : 'http',httpStatus:response.status});
      if (!response.ok) {
        const diagnostic = await httpDiagnostic(response, signal);
        const code = response.status === 401 || response.status === 403 ? 'AUTHENTICATION' : response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'UNAVAILABLE' : 'INVALID_RESPONSE';
        if (diagnostic.retryable && attempt < this.#retry.maxRetries && !signal.aborted) { await this.#wait(attempt, response.headers.get('retry-after'), deadline, signal, terminated, response.status); continue; }
        throw new MemoryModelError(code, 'Provider request failed', diagnostic.retryable, diagnostic);
      }
      let text: string;
      try { text = await readBoundedBody(response, this.#maxResponseBytes, signal); }
      catch (error) {
        if (signal.aborted) throw terminated('response_body', response.status);
        if (error instanceof MemoryModelError && error.diagnostic) throw new MemoryModelError(error.code, error.message, error.retryable, {...error.diagnostic, httpStatus:response.status});
        if (isConnectionFailure(error)) { const mapped = networkFailure(error, false); throw new MemoryModelError(mapped.code, mapped.message, mapped.retryable, {...mapped.diagnostic!,stage:'response_body',httpStatus:response.status}); }
        throw failure('INVALID_RESPONSE', 'response_body', 'body_read_failed', false, response.status);
      }
      if (signal.aborted) throw terminated('response_body', response.status);
      options.onDiagnosticContext?.({stage:'response_envelope',httpStatus:response.status});
      let envelope: unknown;
      try { envelope = JSON.parse(text); } catch { throw failure('INVALID_RESPONSE', 'response_envelope', 'invalid_json', false, response.status); }
      try { return this.decode(envelope, this.#fingerprintKey); }
      catch (error) {
        if (error instanceof MemoryModelError && error.diagnostic) throw new MemoryModelError(error.code, error.message, error.retryable, {...error.diagnostic, httpStatus:response.status});
        throw failure('INVALID_RESPONSE', 'response_envelope', 'invalid_envelope', false, response.status);
      }
    }
  }
  async #wait(attempt: number, retryAfter: string | null, deadline: number, signal: AbortSignal, terminated: (stage: DiagnosticStage, httpStatus?: number) => MemoryModelError, httpStatus?: number): Promise<void> {
    if (signal.aborted) throw terminated('request', httpStatus);
    const delay = retryDelay(attempt, retryAfter, Date.now(), this.#jitter, this.#retry);
    if (Date.now() + delay >= deadline) throw failure('TIMEOUT', 'request', 'timeout', true, httpStatus);
    try { await abortable(this.#sleeper(delay, signal), signal); }
    catch { if (signal.aborted) throw terminated('request', httpStatus); throw failure('UNAVAILABLE', 'request', 'network_error', true, httpStatus); }
  }
}
function failure(code: MemoryModelErrorCode, stage: DiagnosticStage, reason: DiagnosticReason, retryable: boolean, httpStatus?: number): MemoryModelError {
  return new MemoryModelError(code, `Model failure: ${reason}`, retryable, {stage,reason,retryable,...(httpStatus === undefined ? {} : {httpStatus})});
}
async function httpDiagnostic(response: Response, signal: AbortSignal): Promise<FailureDiagnostic> {
  const status = response.status;
  let reason: DiagnosticReason = status === 401 || status === 403 ? 'authentication' : status === 429 ? 'rate_limited' : status >= 500 ? 'provider_unavailable' : 'request_rejected';
  // Error text is transient and bounded in both bytes and time. Match codes exactly, never persist messages.
  try {
    const text = await readBoundedBody(response, 16384, AbortSignal.any([signal, AbortSignal.timeout(2000)]));
    const body = JSON.parse(text) as {error?: {code?: unknown; type?: unknown; message?: unknown}};
    const known: Record<string, DiagnosticReason> = {invalid_json_schema:'invalid_schema',model_not_found:'model_not_found', unsupported_parameter:'unsupported_parameter', context_length_exceeded:'context_length_exceeded', insufficient_quota:'insufficient_quota', invalid_api_key:'authentication'};
    const code = body?.error?.code;
    if (typeof code === 'string' && Object.hasOwn(known, code)) reason = known[code]!;
    else if (code === 'invalid_request_error' && typeof body.error?.message === 'string' && body.error.message.startsWith('Invalid json schema:')) reason = 'invalid_schema';
  } catch { /* HTTP status survives unreadable, oversized, malformed or stalled error bodies. */ }
  return {stage:'http',reason,httpStatus:status,retryable:status === 429 || status >= 500};
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, {once:true}); if (signal?.aborted) abort();
  });
}
export function requireInteger(name: string, value: number, min: number, max: number): void { if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${name} must be an integer between ${min} and ${max}`); }
export function normalizeOpenAICompatibleBaseUrl(value: string): string {
  let url: URL; try { url = new URL(value); } catch { throw new TypeError('baseUrl must be an absolute HTTP(S) URL'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('baseUrl must use HTTP or HTTPS');
  if (url.username || url.password || url.search || url.hash) throw new TypeError('baseUrl must not contain credentials, query, or fragment');
  url.pathname = url.pathname.replace(/\/+$/u, '');
  if (/\/(responses|chat\/completions)$/u.test(url.pathname)) throw new TypeError('baseUrl must be the API root, not a completion endpoint');
  return url.toString().replace(/\/$/u, '');
}

/** Recognized transport codes only; malformed content and arbitrary exception text stay untrusted. */
function isConnectionFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as {code?: unknown; cause?: {code?: unknown}};
  return [e.code,e.cause?.code].some(code => typeof code === 'string' && ['ECONNRESET','ETIMEDOUT','UND_ERR_SOCKET','UND_ERR_BODY_TIMEOUT'].includes(code));
}
