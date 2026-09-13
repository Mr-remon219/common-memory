import type { CommonMemoryConfig } from '../config/config.js';
import { envFilePath } from '../config/config.js';
import { readPrivateEnv } from '../config/private-env.js';
import { modelApi, type ProviderPreset } from '../config/providers.js';
import { NetworkClient } from '../memory-agent-runtime/network/client.js';
import { networkSecret, resolveRoute } from '../memory-agent-runtime/network/route.js';
import { readBoundedBody } from '../memory-agent-runtime/network/bounded-body.js';
import type { RemoteApi } from '../memory-agent-runtime/options.js';

export interface DiscoveredModel { id: string; api: RemoteApi }

/** Explicit configuration-page action only. No cache, timers, runtime imports or memory disclosure. */
export async function discoverModels(provider: ProviderPreset, key: string, config: CommonMemoryConfig,
  options: { signal?: AbortSignal; fetch?: typeof fetch; secrets?: Readonly<Record<string, string>> } = {}): Promise<DiscoveredModel[]> {
  if (provider.id === 'custom') throw new Error('Custom 不进行模型发现。');
  if (!key.trim() || /[\r\n\0]/u.test(key)) throw new Error('API Key 必须是非空单行。');
  let network: NetworkClient | undefined;
  const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(options.signal ? [options.signal] : [])]);
  try {
    const privateEnv = { ...readPrivateEnv(envFilePath()), ...options.secrets };
    // Preserve deployed source priority: inherited network variables still override private drafts.
    const route = resolveRoute(provider.baseUrl, config.remote.proxy, process.env, privateEnv);
    const ca = config.remote.caFileEnv ? networkSecret(config.remote.caFileEnv, process.env, privateEnv) : undefined;
    network = options.fetch ? undefined : new NetworkClient(provider.baseUrl, route, ca);
    const response = await (options.fetch ?? network!.fetch)(`${provider.baseUrl}/models`, {
      method: 'GET', headers: { Authorization: `Bearer ${key.trim()}`, Accept: 'application/json' }, redirect: 'error', signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(response.status === 401 || response.status === 403
        ? '模型列表访问被拒绝，请检查 API Key 及所属地域。'
        : `模型发现失败（HTTP ${response.status}）。可调整网络后重试，或手填同接口模型。`);
    }
    const body: unknown = JSON.parse(await readBoundedBody(response, 1_048_576, signal));
    if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data) || body.data.length > 10_000) throw new Error('模型列表格式不受支持。可手填同接口模型。');
    const models = new Map<string, DiscoveredModel>();
    for (const row of body.data) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id.trim() || row.id.length > 256 || /[\x00-\x20\x7f-\x9f]/u.test(row.id)) continue;
      const api = modelApi(provider.id, row.id);
      if (api) models.set(row.id, { id: row.id, api });
    }
    if (!models.size) throw new Error('没有发现支持当前文本接口的模型。可调整网络后重试，或手填同接口模型。');
    return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    if (signal.aborted) throw new Error(options.signal?.aborted ? '已取消模型发现。' : '模型发现超时，请检查网络后重试。');
    // Never expose provider bodies, credential-bearing exception messages or transport details.
    if (error instanceof Error && /^(?:模型|没有发现)/u.test(error.message)) throw error;
    throw new Error('模型发现失败，请调整网络后重试，或手填同接口模型。');
  } finally { await network?.close(); }
}
