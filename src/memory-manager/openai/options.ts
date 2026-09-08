import { requireInteger } from './remote-http.js';
export type RemoteApi = 'responses' | 'chat_completions';
export const REASONING_EFFORTS = ['none','minimal','low','medium','high','xhigh','max'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export interface RemoteTuning { maxOutputTokens?: number; reasoningEffort?: ReasoningEffort; thinking?: {type:'enabled' | 'disabled'}; enableThinking?: boolean }
/** Allowlisted knobs only. Choosing an API never silently drops another API's options. */
export function validateRemoteTuning(value: RemoteTuning, api: RemoteApi): RemoteTuning {
  const result: RemoteTuning = {};
  if (value.maxOutputTokens !== undefined) { requireInteger('maxOutputTokens', value.maxOutputTokens, 1, 16384); result.maxOutputTokens = value.maxOutputTokens; }
  if (value.reasoningEffort !== undefined) {
    if (api !== 'responses' || !REASONING_EFFORTS.includes(value.reasoningEffort)) throw new TypeError('reasoningEffort requires Responses and a supported effort enum');
    result.reasoningEffort = value.reasoningEffort;
  }
  if (value.thinking !== undefined) {
    if (api !== 'chat_completions' || !value.thinking || typeof value.thinking !== 'object' || Object.keys(value.thinking).length !== 1 || !['enabled','disabled'].includes(value.thinking.type)) throw new TypeError('thinking requires Chat and {type: enabled|disabled}');
    result.thinking = {type:value.thinking.type};
  }
  if (value.enableThinking !== undefined) {
    if (api !== 'chat_completions' || typeof value.enableThinking !== 'boolean') throw new TypeError('enableThinking requires Chat and a boolean');
    if (value.thinking !== undefined) throw new TypeError('thinking and enableThinking are mutually exclusive');
    result.enableThinking = value.enableThinking;
  }
  return result;
}
