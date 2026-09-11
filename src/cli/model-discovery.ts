import type { CommonMemoryConfig } from '../config/config.js';
import { envFilePath } from '../config/config.js';
import { readPrivateEnv } from '../config/private-env.js';
import { modelApi, type ProviderPreset } from '../config/providers.js';
import { NetworkClient } from '../memory-manager/network/client.js';
import { networkSecret, resolveRoute } from '../memory-manager/network/route.js';
import { readBoundedBody } from '../memory-manager/openai/bounded-body.js';
import type { RemoteApi } from '../memory-manager/openai/options.js';

export interface DiscoveredModel { id: string; api: RemoteApi }

/** Explicit configuration-page action only. No cache, timers, runtime imports or memory disclosure. */
export async function discoverModels(provider: ProviderPreset, key: string, config: CommonMemoryConfig,
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<DiscoveredModel[]> {
  if (provider.id === 'custom') throw new Error('Custom 不进行模型发现。');
  if (!key.trim() || /[\r\n\0]/u.test(key)) throw new Error('API Key 必须是非空单行。');
  let network: NetworkClient | undefined;
  const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(options.signal ? [options.signal] : [])]);
  try {
    const privateEnv = readPrivateEnv(envFilePath());
    const route = resolveRoute(provider.baseUrl, config.remote.proxy ?? { mode: 'env' }, process.env, privateEnv);
    const ca = config.remote.caFileEnv ? networkSecret(config.remote.caFileEnv, process.env, privateEnv) : undefined;
    network = options.fetch ? undefined : new NetworkClient(provider.baseUrl, route, ca);
    const response = await (options.fetch ?? network!.fetch)(`${provider.baseUrl}/models`, {
      method: 'GET', headers: { Authorization: `Bearer ${key.trim()}`, Accept: 'application/json' }, redirect: 'error', signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(response.status === 401 || response.status === 403
        ? '模型列表访问被拒绝，请检查 API Key 及所属地域。'
        : `模型发现失败（HTTP ${response.status}）。可重新进入此页面重试，或选择 Custom。`);
    }
    const body: unknown = JSON.parse(await readBoundedBody(response, 1_048_576, signal));
    if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data) || body.data.length > 10_000) throw new Error('模型列表格式不受支持。可选择 Custom。');
    const models = new Map<string, DiscoveredModel>();
    for (const row of body.data) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id.trim() || row.id.length > 256 || /[\x00-\x20\x7f-\x9f]/u.test(row.id)) continue;
      const api = modelApi(provider.id, row.id);
      if (api) models.set(row.id, { id: row.id, api });
    }
    if (!models.size) throw new Error('没有发现支持当前文本接口的模型。可重新进入此页面重试，或选择 Custom。');
    return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    if (signal.aborted) throw new Error(options.signal?.aborted ? '已取消模型发现。' : '模型发现超时，请检查网络后重试。');
    // Never expose provider bodies, credential-bearing exception messages or transport details.
    if (error instanceof Error && /^(?:模型|没有发现)/u.test(error.message)) throw error;
    throw new Error('模型发现失败，请检查网络后重新进入，或选择 Custom。');
  } finally { await network?.close(); }
}
