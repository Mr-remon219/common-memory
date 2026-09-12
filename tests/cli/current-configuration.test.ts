import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, saveApiKeyToEnvFile, saveNetworkSecret, validateConfig } from '../../src/config/config.js';
import { currentConfiguration } from '../../src/cli/current-configuration.js';
import { SESSION_CACHE_DEFAULTS } from '../../src/v2/session.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cm-current-config-'));
  vi.stubEnv('COMMON_MEMORY_HOME', home);
  vi.stubEnv('CM_VIEW_TEST_KEY', '');
  for (const key of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY']) vi.stubEnv(key, '');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
function config() {
  const current = defaultConfig();
  current.remote.model = 'configured-model'; current.remote.apiKeyEnv = 'CM_VIEW_TEST_KEY';
  return current;
}

it('shows the complete configuration, provider tuning and effective defaults without creating memory storage or testing the network', () => {
  const current = config();
  current.remote.preset = 'deepseek'; current.remote.baseUrl = 'https://gateway.test/v1'; current.remote.api = 'chat_completions';
  current.remote.thinking = { type: 'disabled' }; current.remote.maxOutputTokens = 2048;
  current.remote.proxy = { mode: 'direct' }; current.sessionCache = { contextTailTurns: 0 };
  current.disclosure.allowedScopes = [...current.disclosure.allowedScopes, 'project:sample'];
  current.disclosure.allowedProvenance = [...current.disclosure.allowedProvenance, 'document_import']; current.writableScopes = [];
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  try {
    const output = currentConfiguration(current);
    expect(output).toContain('Provider: DeepSeek'); expect(output).toContain('API: chat_completions');
    expect(output).toContain('API Key: missing'); expect(output).toContain('Network: direct → direct (direct_mode); connection not tested');
    expect(output).toContain(JSON.stringify(validateConfig(current), null, 2));
    expect(output).toContain(JSON.stringify({ ...SESSION_CACHE_DEFAULTS, contextTailTurns: 0 }, null, 2));
    expect(existsSync(current.dataRoot)).toBe(false); expect(existsSync(join(home, 'config.json'))).toBe(false); expect(fetch).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

it('reports private API credentials and custom network configuration without displaying secret values', () => {
  const current = config(); current.remote.apiKeySource = 'private-env';
  current.remote.proxy = { mode: 'custom', urlEnv: 'COMMON_MEMORY_PROXY_URL', noProxy: 'localhost' }; current.remote.caFileEnv = 'COMMON_MEMORY_CA_FILE';
  saveApiKeyToEnvFile(current.remote.apiKeyEnv, 'synthetic-private-api-key');
  saveNetworkSecret('COMMON_MEMORY_PROXY_URL', 'https://private-user:private-password@private-proxy.test:9443');
  saveNetworkSecret('COMMON_MEMORY_CA_FILE', '/private/ca-material.pem');
  vi.stubEnv('CM_VIEW_TEST_KEY', 'unrelated-host-api-key');
  const output = currentConfiguration(current);
  expect(output).toContain('API Key: configured (not tested)'); expect(output).toContain('API Key source: private .env only');
  expect(output).toContain('Network: custom → proxy (custom_proxy, https)');
  expect(output).toContain('COMMON_MEMORY_PROXY_URL'); expect(output).toContain('COMMON_MEMORY_CA_FILE');
  for (const secret of ['synthetic-private-api-key', 'unrelated-host-api-key', 'private-user', 'private-password', 'private-proxy.test', '/private/ca-material.pem']) expect(output).not.toContain(secret);
});

it('describes invalid proxy state without exposing its value, and ignores unrelated environment credentials for a private key', () => {
  const current = config(); current.remote.apiKeySource = 'private-env';
  vi.stubEnv('CM_VIEW_TEST_KEY', 'host-only-key'); vi.stubEnv('https_proxy', 'invalid-secret-proxy-value');
  const output = currentConfiguration(current);
  expect(output).toContain('API Key: missing'); expect(output).toContain('Network: invalid local configuration; connection not tested');
  expect(output).not.toContain('host-only-key'); expect(output).not.toContain('invalid-secret-proxy-value');
});

it('shows safe configured legacy values and makes terminal controls in model names inert', () => {
  const current = config(); delete current.remote.proxy; delete current.sessionCache;
  current.remote.model = 'model\u001b[2J'; vi.stubEnv('CM_VIEW_TEST_KEY', 'environment-api-key');
  const output = currentConfiguration(current);
  expect(output).toContain('Provider: OpenAI'); expect(output).toContain('API: responses'); expect(output).toContain('API Key: configured (not tested)');
  expect(output).toContain('Network: legacy → host (legacy_host)'); expect(output).toContain('Model: model\\u001b[2J');
  expect(output).not.toContain('\u001b'); expect(output).not.toContain('environment-api-key');
});
