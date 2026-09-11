import * as clack from '@clack/prompts';
import { join } from 'node:path';
import { configDirectory, loadConfig, type CommonMemoryConfig } from '../config/config.js';
import { configureModel } from './model-configuration.js';
import { installIntegrations, readInstallationState } from './integrations.js';
import { scanIntegrationTargets } from './integration-targets.js';
import { installationTransaction, readInstallationFile, recoverPendingInstallation } from './installation-files.js';
import { log, note, requireInteractive, terminalText, unwrap, UserCancelled } from './tui-prompts.js';

const pendingPath = () => join(configDirectory(), '.installation/setup-pending');
export function setupPending(): boolean { return readInstallationFile(pendingPath()) !== null; }

export async function integrationInstallation(config: CommonMemoryConfig): Promise<number> {
  log('Scanning integrations…');
  const targets = scanIntegrationTargets();
  const prior = readInstallationState();
  if (!targets.length) {
    installIntegrations([], config.dataRoot);
    note('未发现当前可接入的客户端。模型配置已保存。', 'Integration Installation');
    return 0;
  }
  for (;;) {
    const selected = unwrap(await clack.multiselect({
      message: 'Integration Installation', required: false,
      options: targets.map(t => ({ value: t.id, label: t.name, ...(t.hint ? { hint: terminalText(t.hint) } : {}) })),
      initialValues: prior?.targets.map(t => t.id).filter(id => targets.some(t => t.id === id)) ?? targets.filter(t => t.id !== 'chatgpt').map(t => t.id),
    }));
    try {
      installIntegrations(targets.filter(t => selected.includes(t.id)), config.dataRoot);
      for (const target of targets.filter(t => selected.includes(t.id))) {
        clack.log.success(`${target.name} installed`);
        if (target.id === 'codex' && target.hooks) log('Codex /hooks 仍需确认宿主信任；安装不会代替该确认。');
        else if (target.id !== 'pi') log(`${target.name} 已安装读取接入；当前未启用自动会话捕获。`);
      }
      return selected.length;
    } catch (error) { clack.log.error(terminalText(error instanceof Error ? error.message : '安装未完成，请重试。')); }
  }
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
      note('↑↓ Navigate · Space Toggle · Enter Install · Esc Back', 'Integration Installation');
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
