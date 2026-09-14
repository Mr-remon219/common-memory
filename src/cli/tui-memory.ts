import { editResultMessage } from '../v2/service-guidance.js';
import * as clack from './prompt-runtime.js';
import { configDirectory, loadConfig, type CommonMemoryConfig } from '../config/config.js';
import { listProjects, memoryView, recoverHostInbox, registerProject, removeProject, retryJob, runtimeStatus } from './operations.js';
import { modifyMemory } from './modify-memory.js';
import { runFlush } from './flush-command.js';
import { checkConfigUnchanged, runPermissionsWizard } from './tui-settings.js';
import { attempt, confirm, expandPath, log, menu, note, text, viewText } from './tui-prompts.js';
import { launchSessionDrain } from './session-drain.js';

function configured(): CommonMemoryConfig {
  const config = loadConfig();
  if (!config) throw new Error('请先运行 common-memory 完成配置。');
  return config;
}

function authorizedProjects(config: CommonMemoryConfig) {
  return listProjects(config).filter(project => config.disclosure.allowedScopes.includes(`project:${project.id}`));
}

async function browseProjects(): Promise<void> {
  for (;;) {
    const config = configured(), projects = authorizedProjects(config);
    if (!projects.length) note('暂无已授权的项目记忆。可登记项目，再单独授权。', 'Projects');
    const id = await menu('Projects', [
      ...projects.map(project => ({ value: project.id, label: project.name })),
      { value: 'register', label: '登记项目', hint: '不会自动授权' },
      { value: 'remove', label: '移除项目登记', hint: '不删除 Markdown' },
      { value: 'permissions', label: '读取 / 写入授权' },
      { value: 'back', label: '返回 Memory' },
    ]);
    if (id === 'back') return;
    await attempt(async () => {
      if (id === 'permissions') { await runPermissionsWizard(config); return; }
      if (id === 'register') {
        const root = expandPath(await text('项目根目录（已存在的目录）'));
        const name = await text('项目名称');
        note(`目录：${root}\n名称：${name}\n仅登记，不授权读取或写入。之后在「读取 / 写入授权」显式选择。`, '登记项目');
        if (await confirm('登记此项目？')) { checkConfigUnchanged(config); registerProject(config, root, name); }
        return;
      }
      if (id === 'remove') {
        const registered = listProjects(config);
        if (!registered.length) { note('暂无项目登记。', 'Projects'); return; }
        const selected = await menu('移除哪个项目登记？', [...registered.map(p => ({ value: p.id, label: p.name, hint: p.root })), { value: 'back', label: '返回' }]);
        if (selected === 'back') return;
        if (!registered.some(p => p.id === selected)) throw new Error('项目未登记。');
        if (await confirm('仅移除登记？Markdown 和已有权限记录保留；请另行调整权限 / MCP 固定绑定并重启助手。')) {
          checkConfigUnchanged(config); removeProject(config, selected);
        }
        return;
      }
      const project = projects.find(project => project.id === id)!;
      const document = memoryView(configured(), project.root).documents.find(document => document.target === `project:${id}`);
      if (!document || document.empty) { note('暂无可查看的记忆。', project.name); return; }
      await viewText(project.name, document.content);
    });
  }
}

async function searchMemory(): Promise<void> {
  const query = await text('查找关键词（Profile、Preferences 和已授权项目）');
  for (;;) {
    const config = configured();
    // Literal, on-demand filtering of authorized Markdown. No persisted search data.
    const documents = memoryView(config).documents.map(document => ({ ...document, name: document.target === 'profile' ? 'Profile' : 'Preferences' }));
    for (const project of authorizedProjects(config)) {
      const document = memoryView(config, project.root).documents.find(d => d.target === `project:${project.id}`);
      if (document) documents.push({ ...document, name: project.name });
    }
    const matches = documents.filter(document => !document.empty).map(document => ({ ...document,
      lines: document.content.split(/\r?\n/u).flatMap((line, index) => line.toLowerCase().includes(query.toLowerCase()) ? [`${index + 1}: ${line}`] : []),
    })).filter(document => document.lines.length);
    if (!matches.length) { note(`没有找到包含「${query}」的已授权记忆。`, 'Search Memory'); return; }
    const target = await menu('Search Results', [
      ...matches.map(document => ({ value: document.target, label: document.name, hint: `${document.lines.length} 行匹配` })),
      { value: 'back', label: '返回 Memory' },
    ]);
    if (target === 'back') return;
    await attempt(async () => {
      checkConfigUnchanged(config);
      const document = matches.find(d => d.target === target)!;
      note(`「${query}」匹配行：${document.lines.map(line => line.slice(0, line.indexOf(':'))).join(', ')}`, document.name);
      await viewText(document.name, document.content);
    });
  }
}

async function browseMemory(): Promise<void> {
  let focus: string | undefined;
  for (;;) {
    const view = memoryView(configured());
    const action = await menu('Memory', [
      { value: 'search', label: 'Search Memory', hint: '按关键词查找' },
      ...view.documents.map(document => ({ value: document.target, label: document.target === 'profile' ? 'Profile' : 'Preferences', ...(document.empty ? { hint: '暂无内容' } : {}) })),
      { value: 'projects', label: 'Projects' },
      { value: 'back', label: '返回 Memory Control' },
    ], focus);
    if (action === 'back') return;
    focus = action;
    await attempt(async () => {
      if (action === 'search') { await searchMemory(); return; }
      if (action === 'projects') { await browseProjects(); return; }
      const document = memoryView(configured()).documents.find(document => document.target === action);
      const title = action === 'profile' ? 'Profile' : 'Preferences';
      if (!document || document.empty) { note('暂无可查看的记忆。可以通过 Adjust Memory 描述需要记住或修改的内容。', title); return; }
      await viewText(title, document.content);
    });
  }
}

async function processingScreen(): Promise<void> {
  let afterRecoveryId: string | undefined;
  for (;;) {
    const config = configured(), status = runtimeStatus(config, afterRecoveryId);
    if (!status) { note('暂无处理请求。', 'Processing Status'); return; }
    const unfinished = status.jobs.filter(job => job.state !== 'done').slice(-20);
    const states: Record<string, string> = { buffered:'等待当前交互结束',pending: '等待处理', claimed: '处理中', processed: '已处理', running: '处理中', retry: '等待重试', paused:'已暂停（材料保留）', dead: '处理失败', quarantined: '已隔离' };
    note([
      ...status.jobs.filter(job=>job.editResult).slice(-20).map(job=>`编辑任务 ${job.id} · ${editResultMessage(job.editResult!)}`),
      ...status.observations.map(row => `${states[String(row.state)] ?? row.state}: ${row.count}`),
      ...status.jobStates.map(row=>`任务汇总 ${states[String(row.state)] ?? row.state}: ${row.count}`),
      ...unfinished.map((job, index) => `任务 ${index + 1} · ${states[job.state] ?? job.state} · 自动恢复 ${job.automaticRecoveries}/5 · 模型轮次 ${job.modelTurns} · 工具 ${job.toolCalls}${job.issue ? ` · ${job.issue}` : ''}${job.retryAt ? ` · 下次重试 ${new Date(job.retryAt).toISOString()}` : ''}`),
      `宿主收件箱 ${status.host.inbox} · 会话隔离 ${status.host.isolated} · 等待终态 ${status.host.watches}`,
      ...status.host.recoveries.map((failure,index)=>`宿主会话 ${index+1} · ${failure.event} · ${failure.issue}${failure.retryRequested?' · 已请求恢复':''}`),
      '继续处理会将队列中获授权的材料发送给当前模型。已隔离的请求不会自动重试；完整交互立即排队，Flush 不会强制提交仍在生成的交互。',
    ].join('\n'), 'Processing Status');
    const action = await menu('Processing Status', [
      { value: 'refresh', label: '刷新状态 / 返回恢复首页' },
      ...(status.host.nextRecoveryId ? [{ value: `more-host:${status.host.nextRecoveryId}`, label: '更多宿主恢复项' }] : []),
      { value: 'continue', label: '继续处理', hint: 'Ctrl+C 停止等待，已提交的请求仍保留' },
      ...unfinished.flatMap((job, index) => ['dead','paused'].includes(job.state) ? [{ value: `retry:${job.id}`, label: `重试失败任务 ${index + 1}`, hint: job.issue ?? '处理失败' }] : []),
      ...status.host.recoveries.map((failure,index)=>({value:`recover-host:${failure.id}`,label:`${failure.retryRequested?'再次唤醒':'恢复'}宿主会话 ${index+1}`,hint:failure.issue})),
      { value: 'back', label: '返回 Adjust Memory' },
    ]);
    if (action === 'back') return;
    await attempt(async () => {
      checkConfigUnchanged(config);
      if (action === 'refresh') { afterRecoveryId = undefined; return; }
      if (action.startsWith('more-host:')) { afterRecoveryId = action.slice('more-host:'.length); return; }
      if (action.startsWith('recover-host:')) {
        recoverHostInbox(config,action.slice('recover-host:'.length));
        launchSessionDrain(configDirectory());
        log('已按原宿主收件箱身份请求恢复；原材料和游标保持不变。');
        return;
      }
      if (action.startsWith('retry:')) retryJob(config, action.slice(6));
      log('正在处理已提交的请求… Ctrl+C 停止等待。');
      const code = await runFlush(config, () => {});
      if (code === 0) clack.log.success('队列已处理。请查看记忆确认结果，也可能没有变化。');
      else note('仍有未完成请求，请查看状态后继续。', '未完成');
    });
  }
}

async function modifyScreen(): Promise<void> {
  // Existing requests stay manageable from this entry across launches.
  while (runtimeStatus(configured())) {
    const action = await menu('Adjust Memory', [
      { value: 'describe', label: '描述新的调整需求' },
      { value: 'processing', label: 'Processing Status', hint: '查看、继续处理或重试已有请求' },
      { value: 'back', label: '返回 Memory Control' },
    ]);
    if (action === 'back') return;
    if (action === 'processing') { await attempt(processingScreen); continue; }
    break;
  }
  const config = configured();
  const projects = authorizedProjects(config).filter(project => config.writableScopes.includes(`project:${project.id}`));
  let workspace: string | undefined;
  if (projects.length) {
    const scope = await menu('调整哪一类记忆？', [
      ...(config.disclosure.allowedScopes.includes('global') && config.writableScopes.includes('global') ? [{ value: 'global', label: 'Profile / Preferences', hint: '个人背景与全局偏好' }] : []),
      ...projects.map(project => ({ value: project.id, label: project.name, hint: '项目记忆' })),
      { value: 'back', label: '返回 Memory Control' },
    ]);
    if (scope === 'back') return;
    workspace = projects.find(project => project.id === scope)?.root;
  }
  note('用自然语言描述删除、纠正或调整偏好的需求。输入及获授权的记忆会发送给配置的模型；可能先处理已排队材料。\nEnter 提交 · Esc 返回；提交后停止等待不会撤回请求。', 'Adjust Memory');
  const prompt = await text('What would you like to change?');
  checkConfigUnchanged(config);
  log('正在处理… Ctrl+C 停止等待。');
  const result = workspace ? await modifyMemory(config, prompt, { workspace }) : await modifyMemory(config, prompt);
  if (result.outcome.editResult) { note(`请求 ${result.requestId}\n${editResultMessage(result.outcome.editResult)}`, '调整结果'); return; }
  if (result.complete) { clack.log.success('请求已处理。请查看记忆确认结果，也可能没有变化。'); return; }
  if (result.outcome.state === 'quarantined') {
    note('请求已隔离，没有完成修改。请检查是否包含敏感信息或过长内容。', '未完成');
    return;
  }
  note([
    result.cancelled ? '已停止等待，请求仍保留。' : '请求已保存，但尚未处理完成。',
    '不要重复提交同一请求。请从 Adjust Memory → Processing Status 查看状态、继续处理或重试。',
  ].join('\n'), '未完成');
}

export async function memoryControlScreen(): Promise<void> {
  let focus: string | undefined;
  for (;;) {
    const action = await menu('Memory Control', [
      { value: 'browse', label: 'Search / View Memory' },
      { value: 'modify', label: 'Adjust Memory' },
      { value: 'back', label: '返回首页' },
    ], focus);
    if (action === 'back') return;
    focus = action;
    await attempt(async () => {
      if (action === 'browse') await browseMemory();
      else await modifyScreen();
    });
  }
}
