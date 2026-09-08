import type { CommonMemoryConfig } from '../config/config.js';
import { createConfiguredWriter } from '../config/runtime.js';
import type { Writer } from '../v2/writer.js';
/** An idle scheduler can still be waiting for backoff or another lease. Never claim that as completion. */
export async function flushWriter(writer: Writer, log: (line: string) => void = console.log, signal?: AbortSignal): Promise<number> {
  let failed = false;
  writer.store.requestFlush();
  for (;;) {
    const result = await writer.run({force:true,...(signal ? {signal} : {})});
    log(JSON.stringify(result));
    if (['failed','cancelled','quarantined'].includes(result.outcome)) failed = true;
    if (!['committed','noop','ignored','quarantined'].includes(result.outcome)) break;
  }
  return failed || signal?.aborted || writer.store.hasIncompleteWork() ? 1 : 0;
}
export async function runFlush(config: CommonMemoryConfig, log: (line: string) => void = console.log): Promise<number> {
  const writer = createConfiguredWriter(config), controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try { return await flushWriter(writer, log, controller.signal); }
  finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); await writer.close(); }
}
