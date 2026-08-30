export interface ModelUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number }
export interface ApprovedModelRequest { prompt: string; projection: Readonly<Record<string, unknown>>; schema: Readonly<Record<string, unknown>> }
export type MemoryModelResult =
  | { kind: "output"; body: unknown; usage: ModelUsage }
  | { kind: "refusal"; category: "provider_refusal"; fingerprint: string; usage: ModelUsage };
export interface AnalyzeOptions { requestId: string; signal?: AbortSignal; deadlineMs: number }
export interface MemoryModelPort { analyze(request: ApprovedModelRequest, options: AnalyzeOptions): Promise<MemoryModelResult> }
