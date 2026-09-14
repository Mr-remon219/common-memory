import type { ModelDiagnosticContext, ModelUsage } from './model-output.js';

export interface BundleSummary {
  ingest_id: string;
  source: string;
  provenance: string | null;
  scope: string;
  block_count: number;
  bytes: number;
  state: string;
  legacy_subset?: true;
  original_part_count?: number;
}
export interface StructuralBlock {
  block_id: string;
  parent_id: string | null;
  kind: string;
  order: number;
  bytes: number;
  label?: string;
  evidence_ref?: string;
  context_only: boolean;
  metadata: Readonly<Record<string, unknown>>;
}
export interface ManifestPage { blocks: StructuralBlock[]; next: number | null }
export interface ContentPage { block_id: string; content: string; offset: number; next: number | null; bytes: number }
/** Every source page carries its full authoritative descriptor, even without manifest inspection. */
export interface IngestContentPage extends ContentPage { descriptor: StructuralBlock }
export interface MemoryTask {
  version: 'memory_task_v1';
  /** Absent on legacy tasks means observation, never inferred from interactive provenance. */
  task_kind?: 'observation' | 'edit';
  request_id: string;
  now: string;
  bundles: BundleSummary[];
  snapshot: { handle: string; document_count: number };
  decision_schema: Readonly<Record<string, unknown>>;
}
/** Work-local capabilities, not database/file access. Every operation is checked by Core. */
export interface MemoryReadPort {
  manifest(handle: string, offset?: number): ManifestPage;
  read(handle: string, block: string, offset?: number): IngestContentPage;
  memory(handle: string, target?: string, offset?: number): unknown;
  processing(): { complete: boolean; read_bytes: number; total_bytes: number };
}
export interface MemoryAgentOptions {
  signal: AbortSignal;
  /** Legacy compatibility only; runtimes must not enforce a whole-task deadline. */
  deadlineAt?: number;
  configurationVersion?: string;
  validateDecision?: (body: unknown) => void;
  /** Core owns and persists the shared recovery budget. No nested SDK retries. */
  recover?: (error: unknown) => Promise<boolean>;
  onActivity?: (kind: 'model_turn' | 'tool_call') => void;
  onDiagnosticContext?: (context: ModelDiagnosticContext) => void;
}
export interface MemoryDecision { body: unknown; usage: ModelUsage; promptDigest: string }
export interface MemoryAgentRuntime {
  decide(task: MemoryTask, reads: MemoryReadPort, options: MemoryAgentOptions): Promise<MemoryDecision>;
}
