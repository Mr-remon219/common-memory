import * as clack from '@clack/prompts';
import { join } from 'node:path';
import { configDirectory, loadConfig, type CommonMemoryConfig } from '../config/config.js';
import { configureModel } from './model-configuration.js';
import { chooseIntegrations } from './tui-integrations.js';
import { installationTransaction, readInstallationFile, recoverPendingInstallation } from './installation-files.js';
import { log, requireInteractive, UserCancelled } from './tui-prompts.js';

const pendingPath = () => join(configDirectory(), '.installation/setup-pending');
export function setupPending(): boolean { return readInstallationFile(pendingPath()) !== null; }

export async function integrationInstallation(config: CommonMemoryConfig): Promise<number> {
  return chooseIntegrations(config, { retry: true });
}

/** Resume an interrupted integration step without silently rediscovering models on startup. */
export async function runSetupFlow(): Promise<void> {
  requireInteractive();
  clack.intro('Common Memory');
  recoverPendingInstallation(configDirectory());
  let config = loadConfig();
  let resume = config !== null && setupPending();
  for (;;) {
    if (!resume) config = await configureModel(config, { setup: true });
    resume = false;
    try {
      const count = await integrationInstallation(config!);
      installationTransaction(configDirectory(), commit => commit([{ path: pendingPath(), before: readInstallationFile(pendingPath()), after: null }]));
      clack.log.success('Model configured');
      if (count) clack.log.success('Integrations installed');
      else log('No integrations selected');
      clack.outro('Done');
      return;
    } catch (error) { if (!(error instanceof UserCancelled) || error.exit) throw error; }
  }
}
