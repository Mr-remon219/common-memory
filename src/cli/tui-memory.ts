import * as clack from './prompt-runtime.js';
import { loadConfig, type CommonMemoryConfig } from '../config/config.js';
import { listProjects, memoryView, retryJob, runtimeStatus } from './operations.js';
import { modifyMemory } from './modify-memory.js';
import { runFlush } from './flush-command.js';
import { checkConfigUnchanged } from './tui-settings.js';
import { attempt, log, menu, note, text, viewText } from './tui-prompts.js';

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
    if (!projects.length) { note('暂无已授权的项目记忆。', 'Projects'); return; }
    const id = await menu('Projects', [
      ...projects.map(project => ({ value: project.id, label: project.name })),
      { value: 'back', label: '返回 Memory' },
    ]);
    if (id === 'back') return;
    await attempt(async () => {
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
  for (;;) {
    const config = configured(), status = runtimeStatus(config);
    if (!status) { note('暂无处理请求。', 'Processing Status'); return; }
    const unfinished = status.jobs.filter(job => job.state !== 'done');
    const states: Record<string, string> = { pending: '等待处理', claimed: '处理中', processed: '已处理', running: '处理中', retry: '等待重试', dead: '处理失败', quarantined: '已隔离' };
    note([
      ...status.observations.map(row => `${states[String(row.state)] ?? row.state}: ${row.count}`),
      ...unfinished.map((job, index) => `任务 ${index + 1} · ${states[job.state] ?? job.state}${job.issue ? ` · ${job.issue}` : ''}${job.retryAt ? ` · 下次重试 ${new Date(job.retryAt).toISOString()}` : ''}`),
      '继续处理会将队列中获授权的材料发送给当前模型。已隔离的请求不会自动重试。',
    ].join('\n'), 'Processing Status');
    const action = await menu('Processing Status', [
      { value: 'refresh', label: '刷新状态' },
      { value: 'continue', label: '继续处理', hint: 'Ctrl+C 停止等待，已提交的请求仍保留' },
      ...unfinished.flatMap((job, index) => job.state === 'dead' ? [{ value: `retry:${job.id}`, label: `重试失败任务 ${index + 1}`, hint: job.issue ?? '处理失败' }] : []),
      { value: 'back', label: '返回 Adjust Memory' },
    ]);
    if (action === 'back') return;
    await attempt(async () => {
      checkConfigUnchanged(config);
      if (action === 'refresh') return;
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
