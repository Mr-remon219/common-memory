export const MEMORY_MODEL_ERROR_CODES = ["TIMEOUT", "CANCELLED", "RATE_LIMITED", "UNAVAILABLE", "AUTHENTICATION", "INVALID_RESPONSE"] as const;
export type MemoryModelErrorCode = typeof MEMORY_MODEL_ERROR_CODES[number];
export class MemoryModelError extends Error {
  constructor(readonly code: MemoryModelErrorCode, message: string, readonly retryable = false) { super(message); this.name = "MemoryModelError"; }
}
export class MemoryManagerError extends Error {
  constructor(readonly code: "REMOTE_DISABLED" | "DISCLOSURE_BLOCKED" | "INVALID_ANALYSIS" | "DEFERRED", message: string, readonly details: Readonly<Record<string, unknown>> = {}) { super(message); this.name = "MemoryManagerError"; }
}
