export interface RetryPolicy { maxRetries: number; baseDelayMs: number; maxDelayMs: number }
export const defaultRetryPolicy: RetryPolicy = { maxRetries: 2, baseDelayMs: 200, maxDelayMs: 5_000 };
export function retryDelay(attempt: number, retryAfter: string | null, nowMs: number, jitter: () => number, policy: RetryPolicy): number {
  let requested: number | null = null;
  if (retryAfter) { const seconds = Number(retryAfter); if (Number.isFinite(seconds) && seconds >= 0) requested = seconds * 1000; else { const date = Date.parse(retryAfter); if (Number.isFinite(date)) requested = Math.max(0, date - nowMs); } }
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  const delay = requested ?? exponential * (0.5 + Math.max(0, Math.min(1, jitter())) * 0.5);
  return Math.min(policy.maxDelayMs, Math.max(0, Math.round(delay)));
}
