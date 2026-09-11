import * as clack from '@clack/prompts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { apiKeyEnvContents, configDirectory, configFilePath, defaultConfig, envFilePath, loadConfig, validateConfig, type CommonMemoryConfig } from '../config/config.js';
import { installationTransaction, readInstallationFile, recoverPendingInstallation, type FileChange } from './installation-files.js';
import { PROVIDERS, providerFor, type ProviderPreset } from '../config/providers.js';
import { normalizeOpenAICompatibleBaseUrl } from '../memory-manager/openai/openai-responses-adapter.js';
import { discoverModels } from './model-discovery.js';
import { readInstallationState } from './integrations.js';
import { checkConfigUnchanged } from './tui-settings.js';
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

/** Provider → key → fresh discovery → Enter saves. Custom never calls discovery. */
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
      const fields = await configureProvider(provider, current);
      const { reasoningEffort: _reasoning, thinking: _thinking, enableThinking: _enable, ...remote } = current.remote;
      const next = validateConfig({ ...current, remote: { ...remote, ...fields.remote, preset: provider.id, apiKeyEnv: `COMMON_MEMORY_API_KEY_${randomUUID().replaceAll('-', '').toUpperCase()}`, apiKeySource: 'private-env' } });
      // Model choice is the confirmation. Credentials/config/setup checkpoint commit together.
      installationTransaction(configDirectory(), commit => {
        checkConfigUnchanged(existing);
        const beforeEnv = readInstallationFile(envFilePath());
        const changes: FileChange[] = [
          { path: envFilePath(), before: beforeEnv, after: apiKeyEnvContents(next.remote.apiKeyEnv, fields.key, beforeEnv ?? '') },
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
  let baseUrl: string = provider.baseUrl;
  let key = '';
  let step = provider.id === 'custom' ? 0 : 1;
  for (;;) {
    try {
      if (step === 0) {
        baseUrl = normalizeOpenAICompatibleBaseUrl(unwrap(await clack.text({ message: 'Base URL', initialValue: current.remote.preset === 'custom' ? current.remote.baseUrl : '', validate: value => {
          try { normalizeOpenAICompatibleBaseUrl(value ?? ''); } catch { return '请填写有效的 HTTP / HTTPS Base URL'; }
        } })));
        step = 1;
      } else if (step === 1) { key = await apiKey(); step = 2; }
      else if (provider.id === 'custom') {
        const model = await text('Model Name', current.remote.preset === 'custom' ? current.remote.model : '');
        return { key, remote: { baseUrl, model, api: 'chat_completions' as const } };
      } else {
        log('Discovering models… Esc Back');
        const models = await cancellable(signal => discoverModels(provider, key, current, { signal }));
        note('↑↓ Navigate · Enter Select · Esc Back', provider.name);
        const model = await menu('Model Configuration', models.map(m => ({ value: m.id, label: m.id })), models.some(m => m.id === current.remote.model) ? current.remote.model : undefined);
        return { key, remote: { baseUrl, model, api: models.find(m => m.id === model)!.api } };
      }
    } catch (error) {
      if (!(error instanceof UserCancelled) || error.exit) throw error;
      if (step === 0 || step === 1 && provider.id !== 'custom') throw error;
      step--;
    }
  }
}
