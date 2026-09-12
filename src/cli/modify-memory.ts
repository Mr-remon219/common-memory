import { randomUUID } from 'node:crypto';
import type { CommonMemoryConfig } from '../config/config.js';
import { createConfiguredWriter } from '../config/runtime.js';
import { externalPreflight } from '../core/safety/external-preflight.js';
import { ProjectRegistry } from '../v2/registry.js';
import type { ObservationOutcome } from '../v2/runtime.js';

export interface ModifyMemoryResult {
  requestId: string;
  complete: boolean;
  outcome: ObservationOutcome;
  cancelled: boolean;
}

/** A submitted local prompt is a user expression, not a document or an agent import.
 * No Markdown writes here: normal Writer validation, leases and receipts own all commits.
 */
export async function modifyMemory(
  config: CommonMemoryConfig,
  prompt: string,
  options: { workspace?: string; signal?: AbortSignal } = {},
): Promise<ModifyMemoryResult> {
  if (!prompt.trim()) throw new Error('请填写想修改的内容。');
  if (!config.disclosure.allowedProvenance.includes('user_explicit')) throw new Error('当前配置未授权处理用户表达，没有提交修改。');
  let scope = 'global';
  if (options.workspace !== undefined) {
    const project = new ProjectRegistry(config.dataRoot).resolve(options.workspace);
    if (!project) throw new Error('项目尚未登记，没有提交修改。');
    scope = `project:${project.id}`;
  }
  if (!config.disclosure.allowedScopes.includes(scope) || !config.writableScopes.includes(scope)) {
    throw new Error('当前记忆范围未授权读取或修改，没有提交修改。');
  }
  // Reject sensitive/oversized input before opening storage or constructing a model client.
  externalPreflight({ excerpts: [{ text: prompt }] }, config.disclosure);
  options.signal?.throwIfAborted();
  const writer = createConfiguredWriter(config);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000), ...(options.signal ? [options.signal] : [])]);
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  const requestId = `tui:${randomUUID()}`, entryId = 'submitted';
  let admitted = false;
  try {
    signal.throwIfAborted();
    writer.store.enqueue({ sessionId: requestId, entryId, text: prompt, scope, source: 'interactive', observedAt: new Date().toISOString() });
    admitted = true;
    writer.store.requestFlush();
    for (;;) {
      const outcome = writer.store.observationOutcome(requestId, entryId)!;
      if (signal.aborted || ['processed', 'dead', 'quarantined'].includes(outcome.state)) break;
      const result = await writer.run({ force: true, signal });
      // An idle scheduler can mean an outstanding lease/backoff. Do not spin or claim success.
      if (!['committed', 'noop', 'ignored', 'quarantined'].includes(result.outcome)) break;
    }
    const outcome = writer.store.observationOutcome(requestId, entryId)!;
    return { requestId, complete: outcome.state === 'processed', outcome, cancelled: signal.aborted };
  } catch (error) {
    if (admitted) throw new Error('请求已提交，但未能确认处理结果。请在 Memory Control → Adjust Memory → Processing Status 检查并继续处理；不要重复提交。', { cause: error });
    throw error;
  } finally {
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    await writer.close();
  }
}
