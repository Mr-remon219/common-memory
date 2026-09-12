import * as clack from './prompt-runtime.js';
import { configDirectory, loadConfig, type CommonMemoryConfig } from '../config/config.js';
import { integrationHealth, readInstallationState, reconcileIntegrations } from './integrations.js';
import { scanIntegrationTargets, type IntegrationId, type IntegrationTarget } from './integration-targets.js';
import { probeReadIntegration } from './integration-probe.js';
import { recoverPendingInstallation } from './installation-files.js';
import { checkConfigUnchanged, hasApiKey } from './tui-settings.js';
import { confirm, log, note, terminalText, unwrap, UserCancelled } from './tui-prompts.js';

const clients: { id: IntegrationId; name: string; unavailable: string }[] = [
  { id: 'pi', name: 'Pi', unavailable: '未发现当前环境中的 Pi，暂不可接入' },
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
    const available = clients.map(client => targets.find(t => t.id === client.id) ?? prior?.targets.find(t => t.id === client.id)).filter(t => t !== undefined);
    note('↑↓ Navigate · Space Toggle · Enter Continue · Esc Back\n勾选代表应用后的接入状态；取消已勾选的 Agent 会移除接入，记忆保留。\nChatGPT 仅限 Desktop 本地 Work；普通 Chat / 网页版 Plugins 不读取这些本地配置。\n下一步可选择 memory_init 导入；默认只读 MCP 与会话 Hooks，不提供直接写入工具。', 'Agent Integration');
    const selected = unwrap(await clack.multiselect<IntegrationId>({
      message: 'Agent Integration', required: false,
      options: clients.map(client => {
        const installed = prior?.targets.find(t => t.id === client.id), discovered = targets.find(t => t.id === client.id);
        const hint = installed
          ? `${integrationHealth(prior!, client.id) ? '配置已登记（未验证宿主连接）' : '已登记，接入文件缺失或已变更'}${installed.init ? '；含 memory_init 导入' : ''}${!discovered ? '；当前未发现客户端，仍可移除接入' : ''}`
          : discovered ? discovered.hint ?? '可接入' : client.unavailable;
        return { value: client.id, label: client.name, hint: terminalText(hint), disabled: !installed && !discovered };
      }),
      initialValues: prior?.targets.map(t => t.id) ?? [],
    }));
    try {
      // Guard unavailable values independently of the prompt library, including the all-disabled case.
      if (selected.some(id => !available.some(target => target.id === id))) throw new Error('所选 Agent 当前不可接入，未修改任何客户端。');
      const hosts = available.filter(t => selected.includes(t.id) && t.id !== 'pi');
      const importIds = hosts.length ? unwrap(await clack.multiselect<IntegrationId>({
        message: 'AI 理解导入（可选，memory_init）', required: false,
        options: hosts.map(t => ({ value: t.id, label: t.name, hint: '仅当你明确要求导入时调用；保留 AI 来源，需宿主审批' })),
        initialValues: hosts.filter(t => prior?.targets.some(p => p.id === t.id && p.init)).map(t => t.id),
      })) : [];
      if (importIds.some(id => !hosts.some(t => t.id === id))) throw new Error('所选导入客户端不可接入，未修改配置。');
      if (importIds.length && !hasApiKey(config)) throw new Error('memory_init 需要模型密钥才能启动。请先在 Model & Configuration 配置 API Key，或取消导入选择以仅安装读取接入。');
      if (importIds.length) note('独立 init MCP 与只读 MCP 分进程。AI 整理的材料可能发送给配置的模型，并由 Core 更新已授权范围。\n同一配置目录的 Codex / Work 共享 MCP；勾选一方不保证另一前端看不到工具。\n取消导入接入不会撤销已有的 Core 披露授权，也不会撤回已接受的导入。', '导入权限与范围');
      const authorize = importIds.length > 0 && !config.disclosure.allowedProvenance.includes('agent_observation');
      if (authorize && !await confirm('允许将其他 AI 整理的材料发送给配置的模型（agent_observation），并安装所选导入接入？')) throw new UserCancelled();
      const selectedTargets = available.filter(t => selected.includes(t.id)).map((t): IntegrationTarget => {
        const { init: _init, ...base } = t;
        return importIds.includes(t.id) ? { ...base, init: true } : base;
      });
      checkConfigUnchanged(config);
      const changes = reconcileIntegrations(selectedTargets, config.dataRoot, { expectedState: prior,
        ...(authorize ? { authorizeAgentImport: { expectedConfig: config } } : {}),
      });
      const name = (id: IntegrationId) => clients.find(client => client.id === id)!.name;
      for (const id of changes.installed) {
        const target = available.find(t => t.id === id)!;
        clack.log.success(`${name(id)} installed`);
        if (id !== 'pi' && !target.hooks) log(`${name(id)} 已安装读取接入；当前未启用自动会话捕获。`);
      }
      if(available.some(t=>selected.includes(t.id)&&t.id!=='pi'&&t.hooks))log('Codex / Work /hooks 仍需确认宿主信任；安装或升级不会代替该确认。');
      for (const id of changes.removed) clack.log.success(`${name(id)} 接入已移除`);
      if (changes.retained.length) log(`保留接入：${changes.retained.map(name).join('、')}`);
      if (!changes.installed.length && !changes.removed.length) log('Agent 接入已核对；所选客户端的受管理资源已更新。');
      const installedState = readInstallationState()!;
      const checkedRoots = new Set<string>();
      for (const target of selectedTargets.filter(t => t.id !== 'pi')) {
        log(`${target.name} 配置：${target.root}/config.toml · memory_read / memory_status${target.init ? ' + 独立 memory_init（需审批）' : '；未选择 memory_init 导入'}`);
        if (checkedRoots.has(target.root)) continue;
        checkedRoots.add(target.root);
        const probe = await probeReadIntegration(installedState, target);
        log(probe.ok ? '只读 MCP 启动及 tools/list 通过（未读取记忆、未启动导入写端）。'
          : `MCP 检查失败：${probe.code}。配置已保存；请检查上述路径中的 Node / CLI / WSL 是否仍可用后重试。`);
      }
      if (hosts.length) log('请重启宿主并新建会话，在本地 Codex / Work 的 /mcp 确认连接及工具；检查当前 profile / 项目覆盖。探测通过不等于当前聊天已加载。');
      return selected.length;
    } catch (error) {
      if (error instanceof UserCancelled || !options.retry) throw error;
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
