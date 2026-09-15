import { preflightSource, type ExternalSizeCaps } from '../core/safety/external-preflight.js';
import type { RuntimeStore } from './runtime.js';

export interface EditSubmission { sessionId: string; requestId: string; scope: string; text: string }
export interface EditAccess { allowedScopes: readonly string[]; writableScopes: readonly string[]; allowedProvenance: readonly string[]; limits: ExternalSizeCaps }
/** Trusted native user entry only. This helper does not authenticate a model-supplied approval. */
export function validateMemoryEdit(input: EditSubmission, access: EditAccess): void {
  if (!input.text.trim()) throw new Error('INVALID_TEXT_SIZE');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId)) throw new Error('INVALID_SUBMISSION_ID');
  if (!access.allowedProvenance.includes('user_explicit') || !access.allowedScopes.includes(input.scope) || !access.writableScopes.includes(input.scope)) throw new Error('ADJUSTMENT_DISABLED');
  preflightSource(input.text, access.limits);
}
export function queueMemoryEdit(store: RuntimeStore, input: EditSubmission, access: EditAccess) {
  validateMemoryEdit(input, access);
  return store.transaction(() => {
    const duplicate = store.observationStatus(input.sessionId, input.requestId) !== null;
    let observation;
    try { observation = store.enqueue({sessionId:input.sessionId,entryId:input.requestId,text:input.text,scope:input.scope,source:'interactive',taskKind:'edit',observedAt:new Date().toISOString()}); }
    catch (error) { if (error instanceof Error && error.message === 'Conflicting observation identity') throw new Error('SUBMISSION_CONFLICT'); throw error; }
    store.requestFlush();
    return {taskId:`task_${observation.id}`,accepted:true as const,duplicate,state:observation.state,contextId:observation.scope};
  });
}
