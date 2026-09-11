import type { RemoteApi } from '../memory-manager/openai/options.js';

/** API endpoints only. No account, subscription, billing or runtime discovery logic. */
export const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', api: 'chat_completions' },
  { id: 'qwen', name: 'Qwen / Alibaba Bailian', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api: 'chat_completions' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', api: 'responses' },
  { id: 'zhipu', name: 'Zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', api: 'chat_completions' },
  { id: 'opencode-go', name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', api: 'chat_completions' },
  { id: 'kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', api: 'chat_completions' },
  { id: 'custom', name: 'Custom', baseUrl: '', api: 'chat_completions' },
] as const;
export type ProviderId = typeof PROVIDERS[number]['id'];
export interface ProviderPreset { readonly id: ProviderId; readonly name: string; readonly baseUrl: string; readonly api: RemoteApi }

export function providerFor(baseUrl: string, preset?: ProviderId): ProviderPreset {
  return PROVIDERS.find(p => preset ? p.id === preset : p.baseUrl === baseUrl.replace(/\/$/u, '')) ?? PROVIDERS[6];
}

/** Keep only text generation supported by the existing adapters. Listing is not an inference probe. */
export function modelApi(provider: ProviderId, id: string): RemoteApi | null {
  if (/(?:embed|whisper|tts|transcrib|realtime|moderation|dall-e|image|sora|ocr|rerank|audio|cogview|cogvideo)/iu.test(id)) return null;
  if (provider === 'opencode-go') {
    // Go's official endpoint table uses different protocols per family. Anthropic-only models
    // are not selectable until Core has that adapter; never silently send them to Chat.
    if (/^(?:gpt-|grok-|muse-spark-)/u.test(id)) return 'responses';
    if (/^(?:glm-|kimi-|deepseek-|mimo-|longcat-|hy\d)/iu.test(id)) return 'chat_completions';
    return null;
  }
  if (provider === 'openai') return /^(?:gpt-|chatgpt-|o\d)/u.test(id) ? 'responses' : null;
  return 'chat_completions';
}
