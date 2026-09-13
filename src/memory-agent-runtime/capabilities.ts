import type { ModelCapabilityRecord } from '../core/contracts/model-output.js';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createHash } from 'node:crypto';

export function modelCapability(config: {baseUrl:string;model:string;api?: 'responses' | 'chat_completions'}) {
  const known = config.api !== 'chat_completions' && config.baseUrl.replace(/\/$/, '') === 'https://api.openai.com/v1'
    ? openaiProvider().getModels().find(m => m.id === config.model && m.api === 'openai-responses' && m.baseUrl === 'https://api.openai.com/v1') : undefined;
  return known ? { source: 'official-catalog' as const, version: 'pi-ai 0.85.1', contextWindow: known.contextWindow, maxOutput: known.maxTokens, digest: createHash('sha256').update(JSON.stringify(known)).digest('hex'), model: known }
    : { source: 'unknown/custom' as const, contextWindow: null, maxOutput: null, model: undefined };
}

/** Persist catalog identity at selection, without copying Pi Model internals into config. */
export function selectedCapability(config: Parameters<typeof modelCapability>[0]): ModelCapabilityRecord {
  const { model: _model, ...record } = modelCapability(config); return record;
}
