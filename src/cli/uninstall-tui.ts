import * as clack from '@clack/prompts';
import { configDirectory, loadConfig } from '../config/config.js';
import { readInstallationState, removeIntegrations } from './integrations.js';
import { recoverPendingInstallation } from './installation-files.js';
import { npmInstallation, uninstallCompletely } from './uninstall.js';
import { attempt, confirm, menu, note, requireInteractive, unwrap } from './tui-prompts.js';

export async function runUninstallTui(): Promise<void> {
  requireInteractive();
  recoverPendingInstallation(configDirectory());
  clack.intro('Uninstall Common Memory');
  for (;;) {
    const action = await menu('Uninstall Common Memory', [
      { value: 'integrations', label: 'Remove integrations' },
      { value: 'complete', label: 'Remove Common Memory completely' },
    ]);
    let done = false;
    await attempt(async () => {
      if (action === 'integrations') {
        const state = readInstallationState();
        if (!state?.targets.length) { note('没有由此安装器管理的接入。不会猜测删除其他客户端配置。', 'Integrations'); return; }
        note('↑↓ Navigate · Space Toggle · Enter Remove · Esc Back', 'Remove integrations');
        const ids = unwrap(await clack.multiselect({ message: 'Select integrations to remove', required: false,
          options: state.targets.map(t => ({ value: t.id, label: t.name })), initialValues: state.targets.map(t => t.id) }));
        if (!ids.length) return;
        removeIntegrations(ids);
        clack.log.success('Integrations removed · Common Memory 和 Memory Data 已保留');
        done = true;
        return;
      }
      const config = loadConfig();
      if (!config) throw new Error('未找到有效配置，无法确认 Memory 数据归属。可以单独移除接入。');
      const installation = npmInstallation();
      note(`Application   ${installation.packageRoot}\nIntegrations  全部由此安装器管理的接入\nMemory Data   ${config.dataRoot}\n\n先关闭所有已接入客户端和 Common Memory 后台任务。`, 'Remove Common Memory completely');
      if (!await confirm('已停止上述程序，继续卸载 Application 和 Integrations？')) return;
      const deleteMemory = await confirm('同时永久删除 Memory Data？默认保留；删除包含记忆及所有未完成请求。');
      const result = await uninstallCompletely({ config, deleteMemory, clientsStopped: true, installation });
      clack.log.success('Application and integrations removed');
      note(result.retained ? `Memory Data 已保留：${result.retained}` : '已按确认删除 Memory Data。', 'Memory Data');
      done = true;
    });
    if (done) break;
  }
  clack.outro('Done');
}
