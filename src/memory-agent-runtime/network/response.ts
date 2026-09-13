import type { FailureDiagnostic, DiagnosticReason } from '../../core/contracts/diagnostic.js';
import { readBoundedBody } from './bounded-body.js';
export async function httpDiagnostic(response: Response, signal: AbortSignal): Promise<FailureDiagnostic> {
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
