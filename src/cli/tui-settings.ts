import * as clack from '@clack/prompts';
import { MemoryModelError } from '../memory-manager/contracts/errors.js';
import { describeConfiguredNetwork } from '../config/runtime.js';
import { localApiKey, readPrivateEnv } from '../config/private-env.js';
import { PRIVATE_PROXY_KEY, PRIVATE_CA_KEY, resolveRoute, type ProxyConfig } from '../memory-manager/network/route.js';
import { configFilePath, defaultConfig, envFilePath, loadConfig, saveNetworkSecret, saveApiKeyToEnvFile, saveConfig, validateConfig, type CommonMemoryConfig } from '../config/config.js';
import { normalizeOpenAICompatibleBaseUrl } from '../memory-manager/openai/openai-responses-adapter.js';
import { storagePathLines } from './storage-paths.js';
import { listProjects } from './operations.js';
import { confirm, expandPath, menu, note, requireInteractive, text, unwrap, UserCancelled } from './tui-prompts.js';

type Provenance = CommonMemoryConfig['disclosure']['allowedProvenance'][number];
export const PROVENANCE_OPTIONS: { value: Provenance; label: string; hint: string }[] = [
  { value: 'user_explicit', label: 'Delivered user expressions', hint: 'Includes corrections and forget requests' },
  { value: 'agent_observation', label: 'Agent-reported understanding', hint: 'Init only; attributed material, not user statements' },
  { value: 'conversation_context', label: 'Conversation context', hint: 'Assistant/tool and prior context; never evidence' },
  { value: 'document_import', label: 'Imported Markdown documents', hint: 'Attributed material, never user statements' },
];

/** Detect edits made while a form was open rather than silently overwriting them. */
export function checkConfigUnchanged(previous: CommonMemoryConfig | null): void {
  if (JSON.stringify(loadConfig()) !== JSON.stringify(previous)) throw new Error('Configuration changed while this form was open. Reopen the form to use the current configuration.');
}
export function saveSettings(next: CommonMemoryConfig, previous: CommonMemoryConfig): void {
  checkConfigUnchanged(previous);
  saveConfig(next);
  clack.log.success('Settings saved. Restart active Pi/MCP/Codex/Work clients to apply; existing sessions are not hot-revoked.');
}

export async function runSetupWizard(existing: CommonMemoryConfig | null = loadConfig()): Promise<CommonMemoryConfig> {
  requireInteractive();
  const current = existing ?? defaultConfig();
  const baseUrl = unwrap(await clack.text({ message: 'OpenAI-compatible Base URL', initialValue: current.remote.baseUrl,
    validate: value => { try { normalizeOpenAICompatibleBaseUrl(value ?? ''); } catch (error) { return error instanceof Error ? error.message : 'Invalid URL'; } } }));
  const model = await text('Model name', current.remote.model);
  const api = unwrap(await clack.select({ message: 'Request API (explicit; no automatic fallback)', initialValue: current.remote.api ?? 'responses', options: [
    { value: 'responses' as const, label: 'Responses — strict Structured Outputs' },
    { value: 'chat_completions' as const, label: 'Chat Completions — JSON object mode' },
  ] }));
  const apiKeyEnv = unwrap(await clack.text({ message: 'API key environment variable', initialValue: current.remote.apiKeyEnv,
    validate: value => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value?.trim() ?? '') ? undefined : 'Use a valid environment variable name' }));
  const changeKey = await confirm('Store or replace the API key in the private .env? No keeps existing/external credentials (also permits read-only use).');
  const apiKey = changeKey ? unwrap(await clack.password({ message: `API key (stored only in ${envFilePath()})`, validate: value => value?.trim() && !/[\r\n\0]/u.test(value) ? undefined : 'A non-empty single line is required' })) : undefined;
  const dataRoot = existing ? current.dataRoot : expandPath(await text('Local memory data directory', current.dataRoot));
  // Preserve every unrelated setting, including optional sessionCache and legacy proxy absence.
  const { reasoningEffort, thinking, enableThinking, ...remote } = current.remote;
  const sameApi = api === (current.remote.api ?? 'responses');
  const next: CommonMemoryConfig = { ...current, dataRoot, remote: {
    ...remote, baseUrl: normalizeOpenAICompatibleBaseUrl(baseUrl), model, apiKeyEnv: apiKeyEnv.trim(),
    ...(sameApi && current.remote.api === undefined ? {} : { api }),
    ...(sameApi && reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(sameApi && thinking !== undefined ? { thinking } : {}),
    ...(sameApi && enableThinking !== undefined ? { enableThinking } : {}),
  } };
  note([`Model: ${model} (${api})`, `Data: ${dataRoot}`, `Disclosure: ${next.disclosure.allowedScopes.join(', ')}`, `Writable: ${next.writableScopes.join(', ') || '(none)'}`, `Provenance: ${next.disclosure.allowedProvenance.join(', ')}`, !sameApi ? 'API changed: incompatible thinking options will be cleared.' : 'Other settings are preserved.', 'No model request is sent by saving.'].join('\n'), 'Review configuration');
  if (!await confirm('Save this configuration?')) throw new UserCancelled();
  validateConfig(next);
  checkConfigUnchanged(existing);
  // Validate everything before the first write. Secret and config are separate private files.
  if (apiKey !== undefined) saveApiKeyToEnvFile(next.remote.apiKeyEnv, apiKey);
  saveConfig(next);
  clack.log.success(`Configuration saved to ${configFilePath()}. Restart active clients to apply.`);
  return loadConfig()!;
}

export function hasApiKey(config: CommonMemoryConfig): boolean {
  try { return Boolean(localApiKey(config.remote.apiKeyEnv, process.env, readPrivateEnv(envFilePath()))); } catch { return false; }
}
function networkStatus(config: CommonMemoryConfig): string {
  try { const route = describeConfiguredNetwork(config); return `Network: ${route.mode} → ${route.route} (${route.reason}${route.protocol ? `, ${route.protocol}` : ''}); connection not tested`; }
  catch (error) { return `Network: ${error instanceof MemoryModelError ? error.message : 'invalid local configuration'}; connection not tested`; }
}
export function statusLines(config: CommonMemoryConfig): string[] {
  return [`Base URL: ${config.remote.baseUrl}`, `Model: ${config.remote.model}`, `API key: ${hasApiKey(config) ? 'configured' : `missing (${config.remote.apiKeyEnv}); reading still available`}`, `API: ${config.remote.api ?? 'responses'}`, ...storagePathLines(config), networkStatus(config),
    `Disclosure scopes: ${config.disclosure.allowedScopes.join(', ')}`, `Writable scopes: ${config.writableScopes.join(', ') || '(none)'}`, `Provenance: ${config.disclosure.allowedProvenance.join(', ')}`];
}
export function showStatus(config: CommonMemoryConfig): void { note(statusLines(config).join('\n'), 'Common Memory status'); }
export function printStatus(): void {
  const config = loadConfig();
  console.log(config ? statusLines(config).join('\n') : 'Common Memory is not configured. Run: common-memory');
}

export async function runPermissionsWizard(current: CommonMemoryConfig): Promise<void> {
  const known = ['global', ...listProjects(current).map(p => `project:${p.id}`), ...current.disclosure.allowedScopes, ...current.writableScopes];
  const options = [...new Set(known)].map(value => ({ value, label: value }));
  note('Registration, disclosure/read access and write permission are separate. Import provenance never becomes user evidence. Changes do not revoke already running clients.', 'Authorization');
  const allowedScopes = unwrap(await clack.multiselect({ message: 'Scopes allowed for disclosure and consumer reads', options, initialValues: [...current.disclosure.allowedScopes], required: true }));
  const writableScopes = unwrap(await clack.multiselect({ message: 'Scopes writable by Core (independent of disclosure)', options, initialValues: current.writableScopes, required: false }));
  const allowedProvenance = unwrap(await clack.multiselect<Provenance>({ message: 'Material allowed to be sent to the model', options: PROVENANCE_OPTIONS, initialValues: [...current.disclosure.allowedProvenance], required: true }));
  note(`Disclosure: ${allowedScopes.join(', ')}\nWritable: ${writableScopes.join(', ') || '(none)'}\nProvenance: ${allowedProvenance.join(', ')}`, 'Review permissions');
  if (await confirm('Save these authorizations?')) saveSettings({ ...current, writableScopes, disclosure: { ...current.disclosure, allowedScopes, allowedProvenance } }, current);
}

export async function runNetworkWizard(existing: CommonMemoryConfig | null = loadConfig()): Promise<CommonMemoryConfig> {
  requireInteractive();
  if (!existing) throw new Error('Configure the remote API first');
  const mode = unwrap(await clack.select({ message: 'Model network route', initialValue: existing.remote.proxy?.mode ?? 'env', options: [
    { value: 'env' as const, label: 'Environment proxy', hint: 'HTTPS_PROXY / HTTP_PROXY / ALL_PROXY and NO_PROXY' },
    { value: 'direct' as const, label: 'Direct', hint: 'Independent connections; OS VPN/TUN still applies' },
    { value: 'custom' as const, label: 'Custom proxy', hint: 'HTTP/HTTPS; SOCKS5 experimental' },
  ] }));
  let proxy: ProxyConfig = { mode: mode === 'custom' ? 'env' : mode };
  let secret: string | undefined;
  if (mode === 'custom') {
    secret = unwrap(await clack.password({ message: 'Proxy URL (stored privately; not in generated integrations)', validate: value => {
      try { resolveRoute(existing.remote.baseUrl, { mode: 'custom', urlEnv: PRIVATE_PROXY_KEY }, { [PRIVATE_PROXY_KEY]: value }); } catch { return 'Use a valid HTTP, HTTPS or SOCKS5 proxy URL'; }
    } }));
    const noProxy = unwrap(await clack.text({ message: 'Custom bypass hosts (optional)', defaultValue: '', initialValue: existing.remote.proxy?.mode === 'custom' ? existing.remote.proxy.noProxy ?? '' : '', validate: value => {
      try { resolveRoute(existing.remote.baseUrl, { mode: 'custom', urlEnv: PRIVATE_PROXY_KEY, noProxy: value ?? '' }, { [PRIVATE_PROXY_KEY]: secret }); } catch { return 'Invalid bypass list'; }
    } }));
    proxy = { mode: 'custom', urlEnv: PRIVATE_PROXY_KEY, ...(noProxy.trim() ? { noProxy: noProxy.trim() } : {}) };
  }
  const caAction = await menu('Additional CA certificate', [{ value: 'keep', label: 'Keep current setting' }, { value: 'set', label: 'Set PEM file path' }, { value: 'remove', label: 'Use only Node default trust' }]);
  const ca = caAction === 'set' ? expandPath(await text('Additional CA PEM file')) : undefined;
  const { caFileEnv, ...remote } = existing.remote;
  const next: CommonMemoryConfig = { ...existing, remote: { ...remote, proxy, ...(ca ? { caFileEnv: PRIVATE_CA_KEY } : caAction === 'keep' && caFileEnv ? { caFileEnv } : {}) } };
  note(`Route: ${mode}\nCA: ${caAction}\nNo probe is sent. No process-wide network settings are changed.`, 'Review network');
  if (!await confirm('Save network settings?')) throw new UserCancelled();
  validateConfig(next);
  checkConfigUnchanged(existing);
  if (secret !== undefined) saveNetworkSecret(PRIVATE_PROXY_KEY, secret);
  if (ca) saveNetworkSecret(PRIVATE_CA_KEY, ca);
  saveConfig(next);
  clack.log.success('Network settings saved. Restart active clients to apply.');
  return loadConfig()!;
}

/** Less common knobs share the existing validator, not a second configuration schema. */
export async function runAdvancedWizard(current: CommonMemoryConfig): Promise<void> {
  const kind = await menu('Advanced settings', [
    { value: 'tuning', label: 'Model output / thinking options' },
    { value: 'limits', label: 'Scheduler / session cache / disclosure byte limits' },
    { value: 'storage', label: 'Change data directory', hint: 'Select another store; does not migrate data' },
    { value: 'back', label: 'Back' },
  ]);
  if (kind === 'back') return;
  let next: CommonMemoryConfig;
  if (kind === 'storage') {
    note('Stop all clients before switching stores. Existing Markdown and SQLite remain intact. This does not copy, merge or migrate anything. Integrations need regeneration after switching.', 'Storage authority');
    next = { ...current, dataRoot: expandPath(await text('Data directory', current.dataRoot)) };
  } else {
    const { maxOutputTokens, reasoningEffort, thinking, enableThinking } = current.remote;
    const { maxExcerptBytes, maxCandidateBytes, maxTotalBytes } = current.disclosure;
    const initial = kind === 'tuning' ? { maxOutputTokens, reasoningEffort, thinking, enableThinking } : { scheduler: current.scheduler, sessionCache: current.sessionCache, maxExcerptBytes, maxCandidateBytes, maxTotalBytes };
    note(kind === 'tuning' ? 'JSON fields: maxOutputTokens (1–16384), reasoningEffort (Responses only), thinking or enableThinking (Chat only, mutually exclusive). {} clears tuning; API/model must support chosen fields.' : 'Edit the shown JSON limits. Session batching remains exactly ten settled interactions; scheduler settings cannot override it. Omitted sessionCache uses defaults.', 'Advanced configuration');
    const merge = (raw: string): CommonMemoryConfig => {
      const value = JSON.parse(raw) as Record<string, unknown>;
      const keys = kind === 'tuning' ? ['maxOutputTokens', 'reasoningEffort', 'thinking', 'enableThinking'] : ['scheduler', 'sessionCache', 'maxExcerptBytes', 'maxCandidateBytes', 'maxTotalBytes'];
      if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(k => !keys.includes(k))) throw new Error('Only the listed fields are allowed');
      if (kind === 'tuning') {
        const { maxOutputTokens: _a, reasoningEffort: _b, thinking: _c, enableThinking: _d, ...remote } = current.remote;
        return validateConfig({ ...current, remote: { ...remote, ...value } });
      }
      const { scheduler, sessionCache, ...limits } = value;
      const { sessionCache: _cache, ...base } = current;
      return validateConfig({ ...base, scheduler, ...(sessionCache === undefined ? {} : { sessionCache }), disclosure: { ...current.disclosure, ...limits } });
    };
    const raw = unwrap(await clack.text({ message: 'Settings JSON', initialValue: JSON.stringify(initial), validate: value => { try { merge(value ?? ''); } catch (error) { return error instanceof Error ? error.message : 'Invalid settings'; } } }));
    next = merge(raw);
  }
  note(JSON.stringify(kind === 'storage' ? { dataRoot: next.dataRoot } : kind === 'tuning' ? next.remote : { scheduler: next.scheduler, sessionCache: next.sessionCache, disclosure: next.disclosure }, null, 2), 'Review settings (no API key)');
  if (await confirm('Save these settings?')) saveSettings(next, current);
}
