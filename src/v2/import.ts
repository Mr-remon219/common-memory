/** Agent-reported understanding submitted through Init. Stored verbatim as one observation body. */
export const IMPORT_BASES = ['saved_memories', 'chat_history', 'current_conversation', 'project_context', 'mixed', 'unknown'] as const;
export type ImportBasis = typeof IMPORT_BASES[number];
export interface AgentImportPayload { sourceLabel: string; basis: ImportBasis; understanding: string; gaps?: string | undefined }
export const AGENT_IMPORT_SOURCE = 'agent_import';
/** A local file the user chose to import; one observation per structural chunk (see document-import.ts). */
export const DOCUMENT_IMPORT_SOURCE = 'document_import';
export type ProvenanceKind = 'user_explicit' | 'agent_observation' | 'document_import' | 'conversation_context';
/**
 * Host-assigned observation source -> disclosure provenance class. This single mapping decides
 * what is admitted as pending, what shares a batch, which import guard applies and which
 * `disclosure.allowedProvenance` entry authorizes sending it to the remote model.
 */
export function provenanceOf(source: string): ProvenanceKind | null {
  if (source === 'interactive' || source === 'rpc' || source === 'mcp_user_submission' || source === 'codex_user_delivery') return 'user_explicit';
  if (source === AGENT_IMPORT_SOURCE) return 'agent_observation';
  if (source === DOCUMENT_IMPORT_SOURCE) return 'document_import';
  return null;
}
/** Imports are data about the user reported by something other than the user; they never carry user authority. */
export function isImportSource(source: string): boolean { const p = provenanceOf(source); return p !== null && p !== 'user_explicit'; }
export const MAX_IMPORT_UNDERSTANDING_BYTES = 32768;
export const MAX_IMPORT_GAPS_BYTES = 4096;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,63}$/;

export function encodeAgentImport(payload: AgentImportPayload): string {
  if (!LABEL.test(payload.sourceLabel)) throw new Error('INVALID_IMPORT_LABEL');
  if (!IMPORT_BASES.includes(payload.basis)) throw new Error('INVALID_IMPORT_BASIS');
  if (!payload.understanding.trim() || Buffer.byteLength(payload.understanding) > MAX_IMPORT_UNDERSTANDING_BYTES) throw new Error('INVALID_TEXT_SIZE');
  if (payload.gaps !== undefined && Buffer.byteLength(payload.gaps) > MAX_IMPORT_GAPS_BYTES) throw new Error('INVALID_TEXT_SIZE');
  // Fixed key order keeps the digest stable for idempotent retries.
  return JSON.stringify({ kind: AGENT_IMPORT_SOURCE, sourceLabel: payload.sourceLabel, basis: payload.basis, understanding: payload.understanding, ...(payload.gaps !== undefined ? { gaps: payload.gaps } : {}) });
}

export function decodeAgentImport(text: string): AgentImportPayload | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!value || value.kind !== AGENT_IMPORT_SOURCE || typeof value.understanding !== 'string' || typeof value.sourceLabel !== 'string' || !IMPORT_BASES.includes(value.basis as ImportBasis)) return null;
    return { sourceLabel: value.sourceLabel, basis: value.basis as ImportBasis, understanding: value.understanding, ...(typeof value.gaps === 'string' ? { gaps: value.gaps } : {}) };
  } catch { return null; }
}
