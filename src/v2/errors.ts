const codes = new Set(['INVALID_DECISION','INVALID_REQUEST_REFERENCE','INVALID_EVIDENCE_REFERENCE','MISSING_EVIDENCE','INVALID_TARGET_REFERENCE','UNAUTHORIZED_SCOPE','DUPLICATE_SECTION_OPERATION','STALE_LEASE','STALE_REVISION','MODEL_REFUSAL','UNAUTHORIZED_WRITE','SENSITIVE_CONTENT_REJECTED','TIMEOUT','CANCELLED','RATE_LIMITED','UNAVAILABLE','AUTHENTICATION','INVALID_RESPONSE','RECOVERY_CONFLICT']);
/** Only allowlisted diagnostic enums persist; provider/model text can contain secrets. */
export function failureCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && codes.has(error.code)) return error.code;
  if (error instanceof Error && codes.has(error.message)) return error.message;
  return 'VALIDATION_OR_STORAGE_FAILURE';
}
