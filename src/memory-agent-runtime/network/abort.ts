/** Fence even injected transports/streams that ignore AbortSignal. Late results are consumed. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  try { void body?.cancel().catch(() => {}); } catch { /* Cancellation must not delay a bounded failure. */ }
}
