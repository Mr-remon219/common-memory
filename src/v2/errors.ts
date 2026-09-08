import { sanitizeDiagnostic, type DiagnosticStage, type FailureDiagnostic } from '../memory-manager/contracts/diagnostic.js';
const codes = new Set(['INVALID_DECISION','INVALID_REQUEST_REFERENCE','INVALID_EVIDENCE_REFERENCE','MISSING_EVIDENCE','INVALID_TARGET_REFERENCE','UNAUTHORIZED_SCOPE','DUPLICATE_SECTION_OPERATION','STALE_LEASE','STALE_REVISION','MODEL_REFUSAL','UNAUTHORIZED_WRITE','UNAUTHORIZED_FORGET_EVIDENCE','UNAUTHORIZED_IMPORT_OVERWRITE','SENSITIVE_CONTENT_REJECTED','CONFIGURATION','PROXY_AUTHENTICATION','TIMEOUT','CANCELLED','RATE_LIMITED','UNAVAILABLE','AUTHENTICATION','INVALID_RESPONSE','RECOVERY_CONFLICT','LEASE_RENEWAL_FAILED']);
/** Only allowlisted diagnostic enums persist; provider/model text can contain secrets. */
export function failureCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && codes.has(error.code)) return error.code;
  if (error instanceof Error && codes.has(error.message)) return error.message;
  return 'VALIDATION_OR_STORAGE_FAILURE';
}

/** Revalidate at the durable boundary, including errors from caller-provided model ports. */
export function failureDiagnostic(error: unknown, stage: DiagnosticStage = 'core_validation'): FailureDiagnostic {
  if (error && typeof error === 'object' && 'diagnostic' in error) {
    const safe = sanitizeDiagnostic(error.diagnostic); if (safe) return safe;
  }
  const code = failureCode(error);
  if (code === 'TIMEOUT' || code === 'CANCELLED') return {stage:'request',reason:code === 'TIMEOUT' ? 'timeout' : 'cancelled',retryable:code === 'TIMEOUT'};
  if (code === 'LEASE_RENEWAL_FAILED' || code === 'STALE_LEASE') return {stage:'lease',reason:code === 'STALE_LEASE' ? 'stale_lease' : 'lease_renewal_failed',retryable:true};
  if (code === 'MODEL_REFUSAL') return {stage:'model_output',reason:'refusal',retryable:false};
  if (code === 'RECOVERY_CONFLICT') return {stage:'recovery',reason:'recovery_conflict',retryable:false};
  return {stage,reason:stage === 'commit' ? 'commit_failed' : 'core_rejected',retryable:false};
}
