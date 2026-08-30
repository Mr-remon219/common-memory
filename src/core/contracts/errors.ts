export const ERROR_CODES = [
  "PERMISSION_DENIED", "VALIDATION_FAILED", "CONFLICT_DETECTED", "STALE_REVISION",
  "SENSITIVE_CONTENT_REJECTED", "INDEX_OUTDATED", "STORE_LOCKED", "STORE_UNAVAILABLE", "PROTOCOL_ERROR"
] as const;
export type ErrorCode = typeof ERROR_CODES[number];

export class CoreError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(code: ErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = "CoreError";
    this.code = code;
    this.details = details;
  }
}

export function fail(code: ErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new CoreError(code, message, details);
}

export function toCoreError(error: unknown): CoreError {
  if (error instanceof CoreError) return error;
  return new CoreError("STORE_UNAVAILABLE", "The memory store is unavailable", {}, { cause: error });
}
