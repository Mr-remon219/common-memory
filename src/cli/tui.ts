import * as clack from '@clack/prompts';
import { configDirectory, loadConfig, type CommonMemoryConfig } from '../config/config.js';
import { currentConfiguration } from './current-configuration.js';
import { installationOverview } from './installation-overview.js';
import { configureModel } from './model-configuration.js';
import { integrationsScreen } from './tui-integrations.js';
import { memoryControlScreen } from './tui-memory.js';
import { runNetworkWizard } from './tui-settings.js';
import { runSetupFlow, setupPending } from './setup.js';
import { recoverPendingInstallation } from './installation-files.js';
import { attempt, log, menu, note, requireInteractive, UserCancelled, viewText } from './tui-prompts.js';

export { printStatus, showStatus, runNetworkWizard, runSetupWizard } from './tui-settings.js';
export { UserCancelled } from './tui-prompts.js';

function configured(): CommonMemoryConfig {
  const config = loadConfig();
  if (!config) throw new Error('请先运行 common-memory 完成配置。');
  return config;
}

async function configurationScreen(): Promise<boolean> {
  let focus: string | undefined;
  for (;;) {
    const action = await menu('Model & Configuration', [
      { value: 'current', label: 'Current Configuration', hint: '当前完整配置与 API Key 状态' },
      { value: 'model', label: 'Change Model / Provider' },
      { value: 'network', label: 'Network Configuration', hint: '代理与证书' },
      { value: 'test', label: 'Test Connection' },
      { value: 'uninstall', label: 'Uninstall Common Memory' },
      { value: 'back', label: '返回首页' },
    ], focus);
    if (action === 'back') return false;
    focus = action;
    let removed = false;
    await attempt(async () => {
      const config = configured();
      if (action === 'current') await viewText('Current Configuration', `${await installationOverview(config)}\n\n${currentConfiguration(config)}`);
      else if (action === 'model') await configureModel(config);
      else if (action === 'network') await runNetworkWizard(config);
      else if (action === 'test') {
        note('使用少量合成内容测试当前模型连接。Ctrl+C 停止等待。', 'Test Connection');
        const { runNetworkTest } = await import('./network-test.js');
        const passed = await runNetworkTest(config, () => {}) === 0;
        if (passed) clack.log.success('模型连接测试通过。');
        else note('连接测试未通过，请检查当前配置与网络。', 'Test Connection');
      } else removed = await (await import('./uninstall-tui.js')).runCompleteUninstall();
    });
    if (removed) return true;
  }
}

/** The compatibility show entry opens the same workbench as an initialized launch. */
export async function runShowTui(): Promise<void> {
  requireInteractive();
  recoverPendingInstallation(configDirectory());
  configured();
  clack.intro('Common Memory');
  log('↑↓ Navigate · Enter Select / Apply · Space Toggle Agents · Esc Back');
  let focus: string | undefined;
  for (;;) {
    let action: string;
    try {
      action = await menu('Common Memory', [
        { value: 'integrations', label: 'Agent Integration', hint: '选择需要接入的 Agent' },
        { value: 'memory', label: 'Memory Control', hint: '查找、查看与自然语言调整' },
        { value: 'configuration', label: 'Model & Configuration', hint: '查看配置与更换模型' },
        { value: 'exit', label: '退出' },
      ], focus);
    } catch (error) { if (error instanceof UserCancelled) break; throw error; }
    if (action === 'exit') break;
    focus = action;
    let removed = false;
    await attempt(async () => {
      if (action === 'integrations') await integrationsScreen();
      else if (action === 'memory') await memoryControlScreen();
      else removed = await configurationScreen();
    });
    if (removed) break;
  }
  clack.outro('Done');
}

export async function runTui(): Promise<void> {
  requireInteractive();
  recoverPendingInstallation(configDirectory());
  if (loadConfig() && !setupPending()) { await runShowTui(); return; }
  await runSetupFlow();
}
