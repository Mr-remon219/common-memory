/** Persist only these local enums and bounded scalars, never provider text or secrets. */
export const DIAGNOSTIC_STAGES = ['network_config', 'network', 'request', 'http', 'response_body', 'response_envelope', 'model_output', 'core_validation', 'commit', 'lease', 'recovery'] as const;
export const DIAGNOSTIC_REASONS = ['no_proxy_invalid', 'proxy_config_invalid', 'ca_config_invalid', 'proxy_authentication', 'proxy_http_error', 'proxy_unavailable', 'proxy_dns_error', 'tls_verification_failed', 'dns_error', 'connection_refused', 'invalid_schema', 'request_rejected', 'authentication', 'rate_limited', 'provider_unavailable', 'model_not_found', 'unsupported_parameter', 'context_length_exceeded', 'insufficient_quota', 'network_error', 'body_too_large', 'body_read_failed', 'invalid_envelope', 'incomplete_output', 'output_truncated', 'tool_call', 'invalid_json', 'refusal', 'timeout', 'cancelled', 'lease_renewal_failed', 'stale_lease', 'core_rejected', 'commit_failed', 'recovery_conflict'] as const;
export type DiagnosticStage = typeof DIAGNOSTIC_STAGES[number];
export type DiagnosticReason = typeof DIAGNOSTIC_REASONS[number];
export interface FailureDiagnostic { stage: DiagnosticStage; reason: DiagnosticReason; httpStatus?: number; proxyStatus?: number; retryable: boolean }
export function sanitizeDiagnostic(value: unknown): FailureDiagnostic | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const d = value as Record<string, unknown>;
  if (!DIAGNOSTIC_STAGES.includes(d.stage as DiagnosticStage) || !DIAGNOSTIC_REASONS.includes(d.reason as DiagnosticReason) || typeof d.retryable !== 'boolean') return null;
  const result: FailureDiagnostic = {stage: d.stage as DiagnosticStage, reason: d.reason as DiagnosticReason, retryable: d.retryable};
  if (Number.isInteger(d.httpStatus) && Number(d.httpStatus) >= 100 && Number(d.httpStatus) <= 599) result.httpStatus = Number(d.httpStatus);
  if (Number.isInteger(d.proxyStatus) && Number(d.proxyStatus) >= 100 && Number(d.proxyStatus) <= 599) result.proxyStatus = Number(d.proxyStatus);
  return result;
}
