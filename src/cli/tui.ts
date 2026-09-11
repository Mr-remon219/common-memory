import * as clack from '@clack/prompts';
import { configDirectory, loadConfig, type CommonMemoryConfig } from '../config/config.js';
import { listProjects, memoryView } from './operations.js';
import { installationOverview } from './installation-overview.js';
import { modifyMemory } from './modify-memory.js';
import { checkConfigUnchanged } from './tui-settings.js';
import { runSetupFlow, setupPending } from './setup.js';
import { recoverPendingInstallation } from './installation-files.js';
import { attempt, log, menu, note, requireInteractive, text, UserCancelled, viewText } from './tui-prompts.js';

export { printStatus, showStatus, runNetworkWizard, runSetupWizard } from './tui-settings.js';
export { UserCancelled } from './tui-prompts.js';

function configured(): CommonMemoryConfig {
  const config = loadConfig();
  if (!config) throw new Error('请先运行 common-memory 完成配置。');
  return config;
}

async function browseProjects(config: CommonMemoryConfig): Promise<void> {
  for (;;) {
    const projects = listProjects(config).filter(project => config.disclosure.allowedScopes.includes(`project:${project.id}`));
    if (!projects.length) { note('暂无已授权的项目记忆。', 'Projects'); return; }
    const id = await menu('Projects', [
      ...projects.map(project => ({ value: project.id, label: project.name })),
      { value: 'back', label: '返回 Memory' },
    ]);
    if (id === 'back') return;
    await attempt(async () => {
      const project = projects.find(project => project.id === id)!;
      const document = memoryView(config, project.root).documents.find(document => document.target === `project:${id}`);
      if (!document || document.empty) { note('这里还没有记忆。', project.name); return; }
      await viewText(project.name, document.content);
    });
  }
}

async function browseMemory(config: CommonMemoryConfig): Promise<void> {
  let focus: string | undefined;
  for (;;) {
    // Reopen canonical data, not a cached copy or a runtime index.
    const view = memoryView(config);
    const action = await menu('Memory', [
      ...view.documents.map(document => ({ value: document.target, label: document.target === 'profile' ? 'Profile' : 'Preferences', ...(document.empty ? { hint: '暂无内容' } : {}) })),
      { value: 'projects', label: 'Projects' },
      { value: 'back', label: '返回首页' },
    ], focus);
    if (action === 'back') return;
    focus = action;
    await attempt(async () => {
      if (action === 'projects') { await browseProjects(config); return; }
      const document = view.documents.find(document => document.target === action)!;
      const title = action === 'profile' ? 'Profile' : 'Preferences';
      if (document.empty) { note('这里还没有记忆。可以通过 Modify Memory 描述需要记住或修改的内容。', title); return; }
      await viewText(title, document.content);
    });
  }
}

async function modifyScreen(config: CommonMemoryConfig): Promise<void> {
  note('修改个人背景与偏好。输入及获授权的记忆会发送给配置的模型；可能先处理已排队材料。\nEnter 提交 · Esc 返回；提交后停止等待不会撤回请求。', 'Modify Memory');
  const prompt = await text('What would you like to change?');
  checkConfigUnchanged(config);
  log('正在处理… Ctrl+C 停止等待。');
  const result = await modifyMemory(config, prompt);
  if (result.complete) { clack.log.success('请求已处理。请查看记忆确认结果，也可能没有变化。'); return; }
  if (result.outcome.state === 'quarantined') {
    note('请求已隔离，没有完成修改。请检查是否包含敏感信息或过长内容。', '未完成');
    return;
  }
  note([
    result.cancelled ? '已停止等待，请求仍保留。' : '请求已保存，但尚未处理完成。',
    '不要重复提交同一请求。',
    ...(result.outcome.jobState === 'dead' && result.outcome.jobId ? [`重试：common-memory retry ${result.outcome.jobId}`] : []),
    '继续处理：common-memory flush',
  ].join('\n'), '未完成');
}

/** Management is three user tasks, not a second settings/control panel. */
export async function runShowTui(): Promise<void> {
  requireInteractive();
  recoverPendingInstallation(configDirectory());
  configured();
  clack.intro('Common Memory');
  log('↑↓ Navigate · Enter Select · Esc Back');
  let focus: string | undefined;
  for (;;) {
    let action: string;
    try {
      action = await menu('Common Memory', [
        { value: 'overview', label: 'Overview', hint: '位置、大小与客户端' },
        { value: 'browse', label: 'View Memory' },
        { value: 'modify', label: 'Modify Memory' },
        { value: 'exit', label: '退出' },
      ], focus);
    } catch (error) { if (error instanceof UserCancelled) break; throw error; }
    if (action === 'exit') break;
    focus = action;
    await attempt(async () => {
      const config = configured();
      if (action === 'overview') note(await installationOverview(config), 'Overview');
      else if (action === 'browse') await browseMemory(config);
      else await modifyScreen(config);
    });
  }
  clack.outro('Done');
}

export async function runTui(): Promise<void> {
  requireInteractive();
  recoverPendingInstallation(configDirectory());
  if (loadConfig() && !setupPending()) { await runShowTui(); return; }
  await runSetupFlow();
}
