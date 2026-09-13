import { Writer as CoreWriter, type WriterOptions } from '../../src/v2/writer.js';
import type { MemoryModelPort } from './model-fixture-contracts.js';
import { readTask } from './decision-runtime.js';

/** Historical behavior oracles borrow this fake runtime; production has no analyze/projection path. */
export class Writer extends CoreWriter {
  constructor({ model, ...options }: Omit<WriterOptions, 'agent'> & { model: MemoryModelPort }) {
    super({ ...options, agent: { async decide(task, reads, run) {
      const result = await model.analyze(readTask(task, reads), { requestId: task.request_id, signal:run.signal, deadlineMs:run.deadlineAt-Date.now(), ...(run.onDiagnosticContext ? {onDiagnosticContext:run.onDiagnosticContext} : {}) });
      if (result.kind === 'refusal') throw new Error('MODEL_REFUSAL');
      return { body: result.body, usage: result.usage, promptDigest: '5639f68302516cd81190615c4ca1d4d62069673d7f1765ad175c8bf373bd8ee8' };
    } } });
  }
}
