import type { DiagnosticStage } from "./diagnostic.js";
export interface ModelUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number }
export interface ApprovedModelRequest { prompt: string; projection: Readonly<Record<string, unknown>>; schema: Readonly<Record<string, unknown>>; schemaName?: string }
export type MemoryModelResult =
  | { kind: "output"; body: unknown; usage: ModelUsage }
  | { kind: "refusal"; category: "provider_refusal"; fingerprint: string; usage: ModelUsage };
/** Bounded progress facts let the caller retain HTTP context when it must fence a stalled model. */
export interface ModelDiagnosticContext { stage: DiagnosticStage; httpStatus?: number }
export interface AnalyzeOptions { onDiagnosticContext?: (context: ModelDiagnosticContext) => void; requestId: string; signal?: AbortSignal; deadlineMs: number }
export interface MemoryModelPort { serializedRequestBytes?(request: ApprovedModelRequest): number; analyze(request: ApprovedModelRequest, options: AnalyzeOptions): Promise<MemoryModelResult> }
