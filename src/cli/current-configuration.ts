import { validateConfig, type CommonMemoryConfig } from '../config/config.js';
import { providerFor } from '../config/providers.js';
import { describeConfiguredNetwork } from '../config/runtime.js';
import { SESSION_CACHE_DEFAULTS } from '../v2/session.js';
import { storagePathLines } from './storage-paths.js';
import { hasApiKey } from './tui-settings.js';
import { terminalText } from './tui-prompts.js';

/** Read-only configuration display. Private environment values never become display data. */
export function currentConfiguration(config: CommonMemoryConfig): string {
  // The schema rejects inline credentials and credential-bearing endpoint URLs.
  const current = validateConfig(config);
  let network: string;
  try {
    const route = describeConfiguredNetwork(current);
    network = `${route.mode} → ${route.route} (${route.reason}${route.protocol ? `, ${route.protocol}` : ''}); connection not tested`;
  } catch { network = 'invalid local configuration; connection not tested'; }
  return terminalText([
    `Provider: ${providerFor(current.remote.baseUrl, current.remote.preset).name}`,
    `Model: ${current.remote.model}`,
    `Base URL: ${current.remote.baseUrl}`,
    `API: ${current.remote.api ?? 'responses'}`,
    `API Key: ${hasApiKey(current) ? 'configured (not tested)' : 'missing'}`,
    `API Key source: ${current.remote.apiKeySource === 'private-env' ? 'private .env only' : 'environment, then private .env'}`,
    `Network: ${network}`,
    ...storagePathLines(current),
    '',
    'Current configuration:',
    JSON.stringify(current, null, 2),
    '',
    'Effective session cache (including defaults):',
    JSON.stringify({ ...SESSION_CACHE_DEFAULTS, ...current.sessionCache }, null, 2),
  ].join('\n'));
}
