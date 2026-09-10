import * as clack from '@clack/prompts';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDirectory, loadConfig, type CommonMemoryConfig } from '../config/config.js';
import { listProjects } from './operations.js';
import { prepareHostBundle, writeHostBundle } from './work-config.js';
import { renderMcpConfig, type McpConfigOptions } from './mcp-config.js';
import { shellQuote } from './host-launch.js';
import { runInteractiveProcess } from './interactive-process.js';
import { checkConfigUnchanged, hasApiKey } from './tui-settings.js';
import { attempt, confirm, expandPath, menu, note, terminalText, text, unwrap, viewText } from './tui-prompts.js';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

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

async function chooseWorkspaces(config: CommonMemoryConfig): Promise<string[]> {
  const projects = listProjects(config);
  if (!projects.length) return [];
  return unwrap(await clack.multiselect({ message: '还要让助手读取哪些项目？（空格勾选，可不选；个人记忆另行包含）', required: false,
    options: projects.map(p => ({ value: p.root, label: terminalText(p.name), hint: terminalText(`${p.root} · ${config.disclosure.allowedScopes.includes(`project:${p.id}`) ? '已授权读取' : '尚未授权读取'}`) })), initialValues: [] }));
}

async function launchMode(): Promise<McpConfigOptions> {
  // A WSL terminal does not establish the agent's operating environment.
  const mode = await menu('你的 AI 助手运行在哪里？', [
    { value: 'posix', label: '和当前终端在同一环境', hint: 'macOS / Linux / WSL 内运行的助手' },
    { value: 'wsl', label: 'Windows 桌面上', hint: '通过桥接访问当前 WSL 中的记忆' },
  ]);
  if (mode === 'posix') return { wsl: false, workspaces: [] };
  return { wsl: true, distro: await text('WSL 发行版名称', process.env.WSL_DISTRO_NAME ?? ''), user: await text('该发行版中的 Linux 用户名'), workspaces: [] };
}

async function generateHost(config: CommonMemoryConfig, client: 'codex' | 'chatgpt-work'): Promise<void> {
  const options = await launchMode();
  options.workspaces = await chooseWorkspaces(config);
  const output = expandPath(await text('把接入文件保存到哪个新目录？（不能是已有目录）'));
  const args = ['--mode', options.wsl ? 'windows-wsl' : 'posix', '--output', output, ...options.workspaces.flatMap(w => ['--workspace', w])];
  if (options.wsl) {
    args.push('--distro', options.distro!, '--user', options.user!);
    const bridge = await text('Windows 桥接脚本的绝对路径（留空用 wslpath 转换输出目录）', '', true);
    if (bridge) args.push('--bridge-path', bridge);
  }
  const prepared = prepareHostBundle(config, args, client);
  note(`助手：${client}\n保存到：${output}\n包含：连接配置、刷新记忆的 Skill${prepared.bundle.bridge ? '、Windows 桥接脚本' : ''}\n只生成文件，不修改助手设置或 Hook 信任。`, '准备接入文件');
  for (;;) {
    const action = await menu('接下来做什么？', [
      { value: 'save', label: '生成接入文件', hint: '下一步会说明如何安装到助手' },
      { value: 'config', label: '预览连接配置' },
      { value: 'skill', label: '预览刷新记忆 Skill' },
      ...(prepared.bundle.bridge ? [{ value: 'bridge', label: '预览 Windows 桥接脚本' }] : []),
      { value: 'back', label: '返回，不生成文件' },
    ]);
    if (action === 'back') return;
    if (action === 'save') break;
    await viewText(action === 'config' ? '连接配置预览' : action === 'skill' ? '刷新记忆 Skill 预览' : 'Windows 桥接预览', action === 'config' ? prepared.bundle.config : action === 'skill' ? prepared.bundle.skill + '\n' + prepared.bundle.policy : prepared.bundle.bridge!);
  }
  if (!await confirm(`将接入文件写入 ${output}？`)) return;
  checkConfigUnchanged(config);
  if (existsSync(output)) throw new Error('这个目录已存在。请选择新目录，不会覆盖已有文件。');
  writeHostBundle(prepared.output, prepared.bundle);
  note([
    `已生成：${output}`,
    '1. 审阅 common-memory.config.toml，合并到实际使用的助手配置。Work 与 Codex 的配置请分开。',
    '2. 将 skills/memory-refresh 放入该助手的 skills 目录；Windows 还需将桥接脚本放到指定路径。',
    '3. 在助手 /hooks 中审阅并信任命令，然后启动新会话。',
    client === 'codex' ? '启动：codex --profile common-memory' : '在 Work 本地 Agent 中选择对应配置；不适用于普通 Chat。',
    '会话内用 /memory-refresh 刷新。回到「查看记忆」和「处理未完成任务」检查结果。',
    '停用请在助手 /hooks 与 MCP 设置中操作，再移除自己安装的配置与 Skill；记忆文件保留。',
    'Node、安装位置、配置目录或项目选择改变后，请生成新的接入文件。',
  ].join('\n'), '文件已生成 · 还需在助手中启用');
}

async function generateMcp(config: CommonMemoryConfig): Promise<void> {
  const options = await launchMode();
  options.workspaces = await chooseWorkspaces(config);
  const body = renderMcpConfig(config, options);
  await viewText('MCP 配置预览（读取与初始化为独立进程）', body);
  if (await confirm('导出到一个新文件？')) {
    const output = expandPath(await text('新 TOML 文件路径（父目录必须存在）'));
    checkConfigUnchanged(config);
    writeFileSync(output, body, { flag: 'wx', mode: 0o600 });
    clack.log.success(`已导出到 ${terminalText(output)}；尚未安装到助手。`);
  }
  note('将需要的配置块合并到助手的 MCP 设置，读取与初始化保持分离；Codex 应禁用 Init。\n重启助手并检查工具列表。停用请用助手的 MCP 设置，不要删除记忆存储。\n这些模板不会启用 Relay；可信宿主需要通过 CLI 单独配置。', '下一步 · 在助手中启用');
}

async function piIntegration(): Promise<void> {
  note('在同一终端环境中使用 Pi 0.84.4，配置目录需保持一致。\n安装不会自动授权记忆。启停与信任交给 Pi 自己管理。', '连接 Pi');
  const action = await menu('想对 Pi 做什么？', [
    { value: 'install', label: '安装 Common Memory 扩展', hint: '为当前用户登记本地包' },
    { value: 'list', label: '查看已安装扩展', hint: 'pi list' },
    { value: 'config', label: '启用 / 停用扩展', hint: '打开 Pi 自己的配置界面' },
    { value: 'remove', label: '移除扩展', hint: '不会删除记忆' },
    { value: 'back', label: '返回' },
  ]);
  if (action === 'back') return;
  if (action === 'install' && !existsSync(join(packageRoot, 'dist/pi-extension/index.js'))) throw new Error('未找到构建产物。请先构建 Common Memory，再安装扩展。');
  const args = ['install', 'remove'].includes(action) ? [action, packageRoot] : [action];
  note(`pi ${args.map(shellQuote).join(' ')}\nCOMMON_MEMORY_HOME=${configDirectory()}\n使用 PATH 中的 Pi；安装和移除影响用户配置。Pi 可能要求项目信任。`, '即将交给 Pi 执行');
  if (!await confirm('执行以上 Pi 命令？')) return;
  const code = await runInteractiveProcess('pi', args, { ...process.env, COMMON_MEMORY_HOME: configDirectory() });
  if (code !== 0) throw new Error(`Pi 命令未完成或已取消（退出码 ${code}），请在 Pi 中检查状态。`);
  clack.log.success('Pi 命令已结束。修改后请重启 Pi，再检查实际的捕获与记忆读取。');
  note('在 Pi 会话中用 /memory-refresh 刷新记忆，/memory-flush 处理队列。', '下一步');
}

export async function integrationsScreen(): Promise<void> {
  for (;;) {
    const config = loadConfig();
    if (!config) throw new Error('请先完成模型设置。');
    const action = await menu('要连接哪个 AI 助手？', [
      { value: 'pi', label: 'Pi', hint: '安装、启停或移除扩展' },
      { value: 'codex', label: 'Codex', hint: '生成会话与记忆读取配置' },
      { value: 'work', label: 'ChatGPT Work', hint: '生成本地 Agent 接入文件' },
      { value: 'mcp', label: '其他 MCP 助手', hint: '预览、导出 stdio 配置' },
      { value: 'readiness', label: '检查本机接入条件', hint: '不检测助手是否已连接' },
      { value: 'back', label: '返回' },
    ]);
    if (action === 'back') return;
    await attempt(async () => {
      if (action === 'readiness') note(integrationReadiness(config), '本机接入条件');
      else if (action === 'pi') await piIntegration();
      else {
        if (action === 'mcp') await generateMcp(config);
        else await generateHost(config, action === 'codex' ? 'codex' : 'chatgpt-work');
      }
    });
  }
}
