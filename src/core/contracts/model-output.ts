import type { DiagnosticStage } from './diagnostic.js';
export interface ModelUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number }
export interface ModelDiagnosticContext { stage: DiagnosticStage; httpStatus?: number }
/** Selection-time catalog evidence; never trusted instead of current runtime capability resolution. */
export type ModelCapabilityRecord =
  | { source: 'official-catalog'; version: string; digest: string; contextWindow: number; maxOutput: number }
  | { source: 'unknown/custom'; contextWindow: null; maxOutput: null };
/** Provider usage is untrusted JSON. Receipts retain only finite nonnegative numeric counters. */
export function sanitizeModelUsage(value: unknown): ModelUsage {
  const out: ModelUsage = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const key of ['inputTokens','outputTokens','totalTokens'] as const) {
    const counter = (value as Record<string,unknown>)[key];
    if (typeof counter === 'number' && Number.isFinite(counter) && counter >= 0) out[key] = counter;
  }
  return out;
}
