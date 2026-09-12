import * as clack from './prompt-runtime.js';
import { configDirectory, loadConfig, type CommonMemoryConfig } from '../config/config.js';
import { integrationHealth, readInstallationState, reconcileIntegrations } from './integrations.js';
import { scanIntegrationTargets, type IntegrationId } from './integration-targets.js';
import { recoverPendingInstallation } from './installation-files.js';
import { checkConfigUnchanged, hasApiKey } from './tui-settings.js';
import { log, note, terminalText, unwrap } from './tui-prompts.js';

const clients: { id: IntegrationId; name: string; unavailable: string }[] = [
  { id: 'pi', name: 'Pi', unavailable: '未发现支持的 Pi 0.84.4，暂不可接入' },
  { id: 'codex', name: 'Codex', unavailable: '未发现当前环境中的 Codex，暂不可接入' },
  { id: 'chatgpt', name: 'ChatGPT', unavailable: '未发现可接入的本地 Work / Desktop，暂不可接入' },
];

export function integrationReadiness(config: CommonMemoryConfig): string {
  return [
    `Node ${process.versions.node} · 配置目录：${configDirectory()}`,
    `记忆存储：${config.dataRoot}`,
    `读取：不需要 API Key · ${config.disclosure.allowedScopes.join(', ')}`,
    `对话捕获：${config.disclosure.allowedProvenance.includes('user_explicit') ? '已授权' : '未授权'}`,
    `AI 理解导入：${config.disclosure.allowedProvenance.includes('agent_observation') ? '已授权' : '未授权'}`,
    `模型密钥：${hasApiKey(config) ? '已配置，未测试' : '未配置，可只读'}`,
    `可更新范围：${config.writableScopes.join(', ') || '无（只读）'}`,
    '以上是本机配置，不代表助手已安装、启用或信任连接。',
  ].join('\n');
}

/** The same final-state selection drives setup and later integration management. */
export async function chooseIntegrations(config: CommonMemoryConfig, options: { retry?: boolean } = {}): Promise<number> {
  for (;;) {
    recoverPendingInstallation(configDirectory());
    log('Scanning integrations…');
    const targets = scanIntegrationTargets(), prior = readInstallationState();
    // Existing ownership remains removable even if its client has disappeared or its version changed.
    const available = clients.map(client => prior?.targets.find(t => t.id === client.id) ?? targets.find(t => t.id === client.id)).filter(t => t !== undefined);
    note('↑↓ Navigate · Space Toggle · Enter Apply · Esc Back\n勾选代表应用后的接入状态；取消已勾选的 Agent 会移除接入，记忆保留。', 'Agent Integration');
    const selected = unwrap(await clack.multiselect<IntegrationId>({
      message: 'Agent Integration', required: false,
      options: clients.map(client => {
        const installed = prior?.targets.find(t => t.id === client.id), discovered = targets.find(t => t.id === client.id);
        const hint = installed
          ? `${integrationHealth(prior!, client.id) ? '已安装' : '已登记，接入文件缺失或已变更'}${!discovered ? '；当前未发现客户端，仍可移除接入' : ''}`
          : discovered ? discovered.hint ?? '可接入' : client.unavailable;
        return { value: client.id, label: client.name, hint: terminalText(hint), disabled: !installed && !discovered };
      }),
      initialValues: prior?.targets.map(t => t.id) ?? [],
    }));
    try {
      // Guard unavailable values independently of the prompt library, including the all-disabled case.
      if (selected.some(id => !available.some(target => target.id === id))) throw new Error('所选 Agent 当前不可接入，未修改任何客户端。');
      checkConfigUnchanged(config);
      const changes = reconcileIntegrations(available.filter(t => selected.includes(t.id)), config.dataRoot, { expectedState: prior });
      const name = (id: IntegrationId) => clients.find(client => client.id === id)!.name;
      for (const id of changes.installed) {
        const target = available.find(t => t.id === id)!;
        clack.log.success(`${name(id)} installed`);
        if (id === 'codex' && target.hooks) log('Codex /hooks 仍需确认宿主信任；安装不会代替该确认。');
        else if (id !== 'pi') log(`${name(id)} 已安装读取接入；当前未启用自动会话捕获。`);
      }
      for (const id of changes.removed) clack.log.success(`${name(id)} 接入已移除`);
      if (changes.retained.length) log(`保留接入：${changes.retained.map(name).join('、')}`);
      if (!changes.installed.length && !changes.removed.length) log('Agent 接入选择未变化。');
      return selected.length;
    } catch (error) {
      if (!options.retry) throw error;
      clack.log.error(terminalText(error instanceof Error ? error.message : '安装未完成，请重试。'));
      const current = loadConfig();
      if (!current) throw error;
      config = current;
    }
  }
}

export async function integrationsScreen(): Promise<void> {
  const config = loadConfig();
  if (!config) throw new Error('请先完成模型设置。');
  await chooseIntegrations(config);
}
