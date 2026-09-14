import { MemoryModelError } from '../../core/contracts/errors.js';
import { abortable } from './abort.js';

/** A fresh bound for one headers/read operation, never shared across model turns. */
export async function withProgressTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, milliseconds: number, stage: 'request' | 'response_body'): Promise<T> {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) throw new TypeError('Invalid progress timeout');
  parent.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  parent.addEventListener('abort', abort, {once:true});
  const timer = setTimeout(() => controller.abort(new MemoryModelError('TIMEOUT', 'Provider made no progress', true, {stage,reason:stage==='request'?'connection_timeout':'stream_idle_timeout',retryable:true})), milliseconds);
  timer.unref();
  try { return await abortable(operation(controller.signal), controller.signal); }
  finally { clearTimeout(timer); parent.removeEventListener('abort', abort); }
}
