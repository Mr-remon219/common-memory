import { selectedCapability } from '../memory-agent-runtime/capabilities.js';
import * as clack from './prompt-runtime.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { apiKeyEnvContents, configDirectory, configFilePath, defaultConfig, envFilePath, loadConfig, validateConfig, type CommonMemoryConfig } from '../config/config.js';
import { installationTransaction, readInstallationFile, recoverPendingInstallation, type FileChange } from './installation-files.js';
import { PROVIDERS, modelApi, providerFor, type ProviderPreset } from '../config/providers.js';
import { normalizeOpenAICompatibleBaseUrl } from '../memory-agent-runtime/endpoint.js';
import { discoverModels } from './model-discovery.js';
import { readInstallationState } from './integrations.js';
import { checkConfigUnchanged, collectNetworkDraft } from './tui-settings.js';
import { localApiKey, readPrivateEnv } from '../config/private-env.js';
import { log, menu, note, requireInteractive, terminalText, text, unwrap, UserCancelled } from './tui-prompts.js';

/** Only a foreground configuration-page request can install this temporary cancellation handler. */
async function cancellable<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const input = process.stdin, wasRaw = input.isRaw, paused = input.isPaused();
  let exit = false;
  const cancel = () => { exit = true; controller.abort(); };
  const key = (bytes: Buffer) => { if (bytes.equals(Buffer.from([3]))) cancel(); else if (bytes.equals(Buffer.from([0x1b]))) controller.abort(); };
  input.setRawMode?.(true); input.on('data', key); input.resume();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    const result = await action(controller.signal);
    if (controller.signal.aborted) throw new UserCancelled(exit);
    return result;
  } catch (error) { if (controller.signal.aborted) throw new UserCancelled(exit); throw error; }
  finally {
    input.off('data', key); input.setRawMode?.(Boolean(wasRaw)); if (paused) input.pause();
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  }
}

async function apiKey(): Promise<string> {
  return unwrap(await clack.password({ message: 'API Key', validate: value => value?.trim() && !/[\r\n\0]/u.test(value) ? undefined : '请填写非空、单行的 API Key' })).trim();
}

/** Provider → Base URL → key → discovery; failures keep a local retry draft. */
export async function configureModel(existing?: CommonMemoryConfig | null, options: { setup?: boolean } = {}): Promise<CommonMemoryConfig> {
  requireInteractive();
  recoverPendingInstallation(configDirectory());
  existing = existing === undefined ? loadConfig() : existing;
  const current = existing ?? defaultConfig();
  if (!existing) current.dataRoot = readInstallationState()?.dataRoot ?? current.dataRoot;
  let focus = existing ? providerFor(current.remote.baseUrl, current.remote.preset).id : PROVIDERS[0].id;
  for (;;) {
    const id = await menu('Model Configuration', PROVIDERS.map(p => ({ value: p.id, label: p.name })), focus);
    const provider = PROVIDERS.find(p => p.id === id)!;
    focus = provider.id;
    try {
      const beforeEnv = readInstallationFile(envFilePath());
      const fields = await configureProvider(provider, current);
      const { reasoningEffort, thinking, enableThinking, ...remote } = fields.config.remote;
      const sameProvider = providerFor(current.remote.baseUrl, current.remote.preset).id === provider.id;
      const next = validateConfig({ ...current, remote: { ...remote, ...fields.remote,
        ...(sameProvider && fields.remote.api === (current.remote.api ?? 'responses')
          ? fields.remote.api === 'responses' ? { ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) }
            : { ...(thinking !== undefined ? { thinking } : {}), ...(enableThinking !== undefined ? { enableThinking } : {}) } : {}),
        capability: selectedCapability(fields.remote), preset: provider.id,
        apiKeyEnv: fields.keepKey ? current.remote.apiKeyEnv : `COMMON_MEMORY_API_KEY_${randomUUID().replaceAll('-', '').toUpperCase()}`, apiKeySource: 'private-env' } });
      // Model choice is the confirmation. Credentials/config/setup checkpoint commit together.
      installationTransaction(configDirectory(), commit => {
        checkConfigUnchanged(existing);
        if (readInstallationFile(envFilePath()) !== beforeEnv) throw new Error('私有凭据已被其他操作修改，请重新打开表单。');
        let afterEnv = fields.keepKey ? beforeEnv ?? '' : apiKeyEnvContents(next.remote.apiKeyEnv, fields.key, beforeEnv ?? '');
        for (const [name, secret] of Object.entries(fields.secrets)) afterEnv = apiKeyEnvContents(name, secret, afterEnv);
        const changes: FileChange[] = [
          ...(afterEnv !== (beforeEnv ?? '') ? [{ path: envFilePath(), before: beforeEnv, after: afterEnv }] : []),
          { path: configFilePath(), before: readInstallationFile(configFilePath()), after: JSON.stringify(next, null, 2) + '\n' },
        ];
        if (options.setup) {
          const path = join(configDirectory(), '.installation/setup-pending');
          changes.push({ path, before: readInstallationFile(path), after: 'pending\n' });
        }
        commit(changes);
      });
      return loadConfig()!;
    } catch (error) {
      if (error instanceof UserCancelled && error.exit) throw error;
      if (!(error instanceof UserCancelled)) clack.log.error(terminalText(error instanceof Error ? error.message : '模型配置未完成。'));
    }
  }
}

async function configureProvider(provider: ProviderPreset, current: CommonMemoryConfig) {
  const sameProvider = providerFor(current.remote.baseUrl, current.remote.preset).id === provider.id;
  let baseUrl: string = sameProvider ? current.remote.baseUrl : provider.baseUrl;
  let key = '', keepKey = false;
  let config = current, secrets: Record<string, string> = {};
  let step = 0, failed = false, manual = provider.id === 'custom';
  for (;;) {
    try {
      if (step === 0) {
        baseUrl = normalizeOpenAICompatibleBaseUrl(unwrap(await clack.text({ message: 'Base URL', initialValue: baseUrl, validate: value => {
          try { normalizeOpenAICompatibleBaseUrl(value ?? ''); } catch { return '请填写有效的 HTTP / HTTPS Base URL'; }
        } })));
        config = { ...config, remote: { ...config.remote, baseUrl } };
        step = 1;
      } else if (step === 1) {
        let savedKey: string | undefined;
        // Never offer an existing secret to a changed endpoint without a new explicit entry.
        if (sameProvider && baseUrl === current.remote.baseUrl) {
          try { savedKey = localApiKey(current.remote.apiKeyEnv, readPrivateEnv(envFilePath())); } catch { /* Missing private key. */ }
        }
        keepKey = Boolean(savedKey) && await menu('API Key', [
          { value: 'keep', label: '保留当前私有 API Key', hint: '不回显' }, { value: 'replace', label: '填写 / 更换 API Key' },
        ]) === 'keep';
        if (keepKey) key = savedKey!;
        else key = await apiKey();
        step = 2;
      } else if (failed) {
        const action = await menu('模型发现未完成 · URL / Key 草稿已保留', [
          { value: 'retry', label: '重试发现' }, { value: 'network', label: '调整网络草稿', hint: 'direct / env / custom + CA；暂不保存' },
          { value: 'manual', label: '手填同 Provider / API 的模型' }, { value: 'edit', label: '修改 URL / Key' },
          { value: 'back', label: '返回 Provider（丢弃草稿）' },
        ]);
        if (action === 'back') throw new UserCancelled();
        if (action === 'network') {
          try {
            const draft = await collectNetworkDraft(config, secrets);
            config = draft.config; secrets = draft.secrets;
          } catch (error) {
            if (error instanceof UserCancelled && error.exit) throw error;
            if (!(error instanceof UserCancelled)) note('网络草稿未完成，请检查本地网络设置。URL / Key 已保留。', provider.name);
            continue;
          }
        }
        if (action === 'edit') step = 0;
        manual = action === 'manual'; failed = false;
      } else if (manual) {
        const model = await text('Model Name', sameProvider ? current.remote.model : '');
        const api = provider.id === 'opencode-go' ? modelApi(provider.id, model) : provider.id === 'custom' && sameProvider ? current.remote.api ?? provider.api : provider.api;
        if (!api) { note('此模型没有已支持的 Provider / API 映射，请选择支持的文本模型。', provider.name); continue; }
        return { key, keepKey, config, secrets, remote: { baseUrl, model, api } };
      } else {
        log('Discovering models… Esc Back');
        let models;
        try { models = await cancellable(signal => discoverModels({ ...provider, baseUrl }, key, config, { signal, secrets })); }
        catch (error) {
          if (error instanceof UserCancelled) throw error;
          // Discovery already redacts transport/provider details; never log arbitrary errors here.
          note('模型发现失败。URL / Key 已保留，可调整网络重试或手填模型。', provider.name);
          failed = true; continue;
        }
        note('↑↓ Navigate · Enter Select · Esc Back', provider.name);
        const model = await menu('Model Configuration', models.map(m => ({ value: m.id, label: m.id })), models.some(m => m.id === current.remote.model) ? current.remote.model : undefined);
        return { key, keepKey, config, secrets, remote: { baseUrl, model, api: models.find(m => m.id === model)!.api } };
      }
    } catch (error) {
      if (!(error instanceof UserCancelled) || error.exit) throw error;
      if (failed) throw error;
      if (step === 0) throw error;
      step--;
    }
  }
}
