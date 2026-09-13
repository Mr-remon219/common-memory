import { preflightSource, type ExternalSizeCaps } from '../core/safety/external-preflight.js';
import { AGENT_IMPORT_SOURCE, encodeAgentImport, type AgentImportPayload } from './import.js';
import type { RuntimeStore } from './runtime.js';

export interface AgentImportSubmission extends AgentImportPayload { importId: string; contextId: string }
/** The adapter supplies its authenticated namespace and authorized contexts, never the model. */
export function queueAgentImport(store: RuntimeStore, sessionId: string, input: AgentImportSubmission, access: {
  contexts: readonly string[]; enabled: boolean; maxBytes?: number | null | undefined; limits?: ExternalSizeCaps;
}, signal?: AbortSignal) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.importId)) throw new Error('INVALID_SUBMISSION_ID');
  if (!access.enabled) throw new Error('INIT_DISABLED');
  if (!access.contexts.includes(input.contextId)) throw new Error('CONTEXT_UNAVAILABLE');
  const text = encodeAgentImport(input);
  if (Buffer.byteLength(text) > (access.maxBytes ?? Number.MAX_SAFE_INTEGER)) throw new Error('INVALID_TEXT_SIZE');
  preflightSource(text, access.limits ?? {maxTotalBytes:access.maxBytes ?? null});
  if (signal?.aborted) throw new Error('CANCELLED');
  return store.transaction(() => {
    const duplicate = store.observationStatus(sessionId, input.importId) !== null;
    let observation;
    try { observation = store.enqueue({sessionId,entryId:input.importId,scope:input.contextId,text,source:AGENT_IMPORT_SOURCE,observedAt:new Date().toISOString()}); }
    catch (error) {
      if (error instanceof Error && error.message === 'Conflicting observation identity') throw new Error('SUBMISSION_CONFLICT');
      throw error;
    }
    store.requestFlush();
    return {accepted:true as const,duplicate,state:observation.state,contextId:observation.scope};
  });
}
