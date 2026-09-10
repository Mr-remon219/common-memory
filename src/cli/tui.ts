import * as clack from '@clack/prompts';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDirectory, loadConfig, type CommonMemoryConfig } from '../config/config.js';
import { DOCUMENT_AUTHORS } from '../v2/document-import.js';
import { listProjects, memoryView, registerProject, removeProject, retryJob, runtimeStatus } from './operations.js';
import { runFlush } from './flush-command.js';
import { runImport } from './import-command.js';
import { runNetworkTest } from './network-test.js';
import { runInteractiveProcess } from './interactive-process.js';
import { integrationsScreen } from './tui-integrations.js';
import { checkConfigUnchanged, hasApiKey, runAdvancedWizard, runCredentialsWizard, runNetworkWizard, runPermissionsWizard, runSetupWizard, statusLines } from './tui-settings.js';
import { attempt, confirm, expandPath, log, menu, note, requireInteractive, text, UserCancelled, viewText } from './tui-prompts.js';

export { printStatus, showStatus, runNetworkWizard, runSetupWizard } from './tui-settings.js';
export { UserCancelled } from './tui-prompts.js';

function configured(): CommonMemoryConfig {
  const config = loadConfig();
  if (!config) throw new Error('请先从首页完成初次设置。');
  return config;
}

const stateLabels: Record<string, string> = { pending: '待处理', claimed: '处理中', running: '处理中', processed: '已处理', done: '已完成', retry: '等待重试', dead: '需要处理', quarantined: '已隔离' };
const stateLabel = (state: string): string => stateLabels[state] ?? state;

function queueSummary(status: ReturnType<typeof runtimeStatus>): string {
  if (!status) return '还没有处理记录。连接助手或导入文件后，可以在这里查看进度。';
  const states = status.observations.map(row => `${stateLabel(String(row.state))} ${row.count}`).join(' · ') || '暂无材料';
  const dead = status.jobs.filter(j => j.state === 'dead').length;
  const retry = status.jobs.filter(j => j.state === 'retry').length;
  return [states, `任务：${dead} 个需要处理 · ${retry} 个等待重试`,
    `会话：${status.sessions.length} 个 · ${status.sessions.filter(s => s.closing && !s.complete).length} 个已退出、尚未处理完`,
    ...(status.unbound || status.quarantinedDeliveries ? [`交付异常：${status.unbound} 个未关联 · ${status.quarantinedDeliveries} 个已隔离`] : []),
    dead ? '下一步：打开「查看失败任务 / 重试」，先看原因再重试。' : '会话每完成 10 次交互或实际退出时交接；正在进行的尾批不会被强行提交。'].join('\n');
}

async function overview(): Promise<void> {
  for (;;) {
    const config = configured();
    note(queueSummary(runtimeStatus(config)), '运行状态 · 仅检查本机');
    const action = await menu('想检查哪一项？', [
      { value: 'refresh', label: '刷新状态' },
      { value: 'details', label: '查看配置与存储路径', hint: '技术详情' },
      { value: 'maintenance', label: '处理未完成的任务' },
      { value: 'back', label: '返回首页' },
    ]);
    if (action === 'back') return;
    if (action === 'details') await attempt(() => viewText('配置详情（未测试连接）', statusLines(config).join('\n')));
    if (action === 'maintenance') await attempt(maintenanceScreen);
  }
}

async function workspace(config: CommonMemoryConfig): Promise<string | undefined> {
  const projects = listProjects(config);
  const selected = await menu('查看或导入到哪里？', [
    { value: 'global', label: '个人记忆', hint: config.disclosure.allowedScopes.includes('global') ? '个人背景与偏好' : '尚未授权读取' },
    ...projects.map(p => ({ value: p.id, label: p.name, hint: `${p.root}${config.disclosure.allowedScopes.includes(`project:${p.id}`) ? '' : ' · 尚未授权读取'}` })),
    { value: 'back', label: '返回' },
  ]);
  if (selected === 'back') throw new UserCancelled();
  return selected === 'global' ? undefined : projects.find(p => p.id === selected)!.root;
}

async function browseMemory(config: CommonMemoryConfig): Promise<void> {
  const selected = await workspace(config);
  const view = memoryView(config, selected);
  if (!view.documents.length) { note('这个范围尚未授权读取。请到「项目与权限」检查读取权限。', '暂时无法查看'); return; }
  const labels: Record<string, string> = { profile: '个人背景', preferences: '使用偏好' };
  for (;;) {
    const target = await menu('想看看记住了什么？', [
      ...view.documents.map(d => ({ value: d.target, label: labels[d.target] ?? '项目记忆', hint: d.empty ? '暂无内容' : `${d.bytes} 字节` })),
      { value: 'location', label: '查看文件位置', hint: '可用自己的编辑器修改 Markdown' },
      { value: 'back', label: '返回首页' },
    ]);
    if (target === 'back') return;
    if (target === 'location') { note(join(config.dataRoot, 'memory'), '记忆文件目录'); continue; }
    const document = view.documents.find(d => d.target === target)!;
    if (document.empty) { note('这里还没有记忆。可以先连接助手聊天，或从首页导入 Markdown；处理完成后再来看看。', labels[target] ?? '项目记忆'); continue; }
    await attempt(() => viewText(labels[target] ?? '项目记忆', document.content));
  }
}

async function importMarkdown(config: CommonMemoryConfig): Promise<void> {
  if (!config.disclosure.allowedProvenance.includes('document_import')) {
    note('导入前，需要允许模型处理你选择的 Markdown。文件会保留来源，不会被当成你逐句说过的话。', '先确认导入权限');
    if (!await confirm('现在打开权限设置？')) return;
    await runPermissionsWizard(config);
    config = configured();
    if (!config.disclosure.allowedProvenance.includes('document_import')) { log('未开启 Markdown 导入，没有添加文件。'); return; }
  }
  const file = expandPath(await text('要导入哪个 Markdown 文件？（.md / .markdown，不支持符号链接）'));
  const selected = await workspace(config);
  const authorLabels = { user: '我写的', agent: 'AI 整理的', third_party: '其他人写的', mixed: '多个来源混合', unknown: '不确定' };
  const author = await menu('这份材料是谁写的？', DOCUMENT_AUTHORS.map(value => ({ value, label: authorLabels[value] })), 'unknown');
  const label = await text('给来源起个名字（留空使用文件名）', '', true);
  const mode = await menu('什么时候整理？', [
    { value: 'wait', label: '现在整理', hint: '会调用模型，也可能处理其他已排队材料' },
    { value: 'queue', label: '先排队，稍后整理', hint: '后台处理器运行时仍可能自动处理' },
  ]);
  note(`文件：${file}\n范围：${selected ?? '个人记忆'}\n来源：${label || basename(file)} · ${authorLabels[author as keyof typeof authorLabels]}\n处理：${mode === 'wait' ? '现在调用模型' : '先加入队列'}\n\n导入不保证保留全部内容，也不能仅凭它删除你表达过的记忆。\n入队后再取消，不会撤回已添加的材料。`, '确认导入');
  if (!await confirm('按以上方式导入？')) return;
  checkConfigUnchanged(config);
  const args = [file, '--author', author, ...(selected ? ['--workspace', selected] : []), ...(label ? ['--label', label] : []), ...(mode === 'queue' ? ['--no-wait'] : [])];
  log('正在导入… Ctrl+C 可停止等待，已入队的材料会保留。');
  const { exitCode, outcome } = await runImport(config, args, log);
  if (exitCode) clack.log.warn('还未处理完成。可到「处理未完成任务」查看原因。');
  else if (outcome?.complete) clack.log.success('整理完成。到「查看记忆」检查实际保留的内容；也可能没有新增记忆。');
  else clack.log.info('已排队，尚未整理。之后可在「查看记忆」确认结果。');
}

async function projectsScreen(): Promise<void> {
  for (;;) {
    const config = configured();
    const projects = listProjects(config);
    const action = await menu('项目与权限', [
      { value: 'register', label: '添加项目', hint: '先登记目录，再单独授权' },
      { value: 'permissions', label: '设置读取、写入和材料权限' },
      ...projects.map(p => ({ value: p.id, label: p.name, hint: `${config.disclosure.allowedScopes.includes(`project:${p.id}`) ? '可读' : '不可读'} · ${config.writableScopes.includes(`project:${p.id}`) ? '可写' : '不可写'}` })),
      { value: 'back', label: '返回首页' },
    ]);
    if (action === 'back') return;
    await attempt(async () => {
      if (action === 'permissions') { await runPermissionsWizard(config); return; }
      if (action === 'register') {
        const root = expandPath(await text('项目目录', process.cwd()));
        const name = await text('项目名称', basename(root));
        if (await confirm(`添加「${name}」？这一步只登记目录，不自动授权。`)) {
          checkConfigUnchanged(config);
          const project = registerProject(config, root, name);
          clack.log.success(`已添加项目。下一步：在「设置读取、写入和材料权限」中授权。`);
          note(project.root, project.name);
        }
        return;
      }
      const project = projects.find(p => p.id === action)!;
      note(`目录：${project.root}\n记忆：${join(config.dataRoot, 'memory/projects', `${project.id}.md`)}`, project.name);
      const operation = await menu('要对这个项目做什么？', [{ value: 'permissions', label: '设置权限' }, { value: 'remove', label: '移除项目登记', hint: '保留记忆文件' }, { value: 'back', label: '返回' }]);
      if (operation === 'permissions') await runPermissionsWizard(config);
      else if (operation === 'remove' && await confirm(`移除「${project.name}」的登记？记忆文件和权限项会保留，正在运行的客户端需要重启。`)) {
        checkConfigUnchanged(config);
        const removed = removeProject(config, project.id);
        note(removed ? '已移除登记，记忆文件仍在。请另外检查权限设置。' : '这个项目已经不在登记列表中。', '处理结果');
      }
    });
  }
}

async function maintenanceScreen(): Promise<void> {
  for (;;) {
    const config = configured();
    const status = runtimeStatus(config);
    note(queueSummary(status), '处理进度');
    const action = await menu('要怎么继续？', [
      { value: 'flush', label: '整理已排队材料', hint: '调用模型；不提交进行中的会话尾批' },
      { value: 'jobs', label: '查看失败任务 / 重试' },
      { value: 'drain', label: '恢复退出后未完成的会话', hint: '调用模型，可能需要等待' },
      { value: 'sessions', label: '查看会话摘要', hint: '不显示聊天正文' },
      { value: 'refresh', label: '刷新进度' },
      { value: 'back', label: '返回' },
    ]);
    if (action === 'back') return;
    await attempt(async () => {
      if (action === 'sessions') {
        const sessions = status?.sessions ?? [];
        if (!sessions.length) { log('还没有会话记录。连接助手并开始新会话后再来看看。'); return; }
        await viewText('会话摘要', sessions.map(s => `${s.id}\n${s.complete ? '交接已完成' : s.closing ? '已退出，等待处理' : '尚未收到退出交接'} · ${s.batches} 批 · 待处理 ${s.pending} · 失败 ${s.failed}`).join('\n\n'));
        return;
      }
      if (action === 'jobs') {
        const jobs = [...(status?.jobs ?? [])].reverse();
        if (!jobs.length) { log('还没有任务记录。'); return; }
        const id = await menu('任务记录（最新在前）', [...jobs.map(j => ({ value: j.id, label: `${stateLabel(j.state)} · ${j.id}`, hint: `已尝试 ${j.attempts} 次${j.issue ? ` · ${j.issue}` : ''}` })), { value: 'back', label: '返回' }]);
        if (id === 'back') return;
        const job = jobs.find(j => j.id === id)!;
        await viewText('任务诊断（不含模型响应正文）', JSON.stringify(job, null, 2));
        if (job.state === 'dead' && await confirm('将这个任务重新加入队列？之后选择「整理已排队材料」继续。')) { checkConfigUnchanged(config); retryJob(config, id); clack.log.success('已重新排队，尚未写入记忆。'); }
      } else if (action === 'flush' && await confirm('现在调用模型整理队列？获授权的材料会发给配置的模型。')) {
        checkConfigUnchanged(config);
        log('正在整理… Ctrl+C 可停止等待，未完成的任务会保留。');
        const code = await runFlush(config, log);
        if (code) clack.log.warn('还未完成或已取消。请查看任务诊断，等待重试不代表已完成。');
        else clack.log.success('已排队的整理任务已完成。进行中的会话尾批不受影响。');
      } else if (action === 'drain' && await confirm('恢复会话交接并调用模型？获授权的材料会发送，可能需要等待其他处理器或重试间隔。')) {
        checkConfigUnchanged(config);
        log('正在恢复… Ctrl+C 可停止本次等待，未完成的任务仍可恢复。');
        const code = await runInteractiveProcess(process.execPath, [fileURLToPath(new URL('./main.js', import.meta.url)), 'session-drain', '--home', configDirectory()]);
        if (code) clack.log.warn(`恢复未完成或已取消（退出码 ${code}）。请先检查进度。`);
        else clack.log.success('已交接的会话材料处理完成；仍在运行的会话不会被关闭。');
      }
    });
  }
}

async function testConnection(config: CommonMemoryConfig): Promise<void> {
  if (!await confirm('发送一条简短测试请求？会调用模型，但不发送记忆内容。')) return;
  checkConfigUnchanged(config);
  log('正在测试连接… 最多 60 秒，Ctrl+C 可取消。');
  const code = await runNetworkTest(config, log);
  if (code) clack.log.warn('连接未通过。请检查模型、API Key 或网络设置，再试一次。');
  else clack.log.success('模型连接正常。此测试不代表助手已接入，也未测试记忆写入。');
}

async function settingsScreen(): Promise<void> {
  for (;;) {
    const action = await menu('设置', [
      { value: 'model', label: '更换模型 / API 地址' },
      { value: 'credentials', label: '设置 / 更换 API Key', hint: '不用重填模型' },
      { value: 'network', label: '设置代理 / 网络' },
      { value: 'probe', label: '测试模型连接', hint: '不发送记忆' },
      { value: 'permissions', label: '设置权限' },
      { value: 'advanced', label: '高级设置', hint: '输出长度、思考、运行限制、存储目录' },
      { value: 'back', label: '返回首页' },
    ]);
    if (action === 'back') return;
    await attempt(async () => {
      const config = configured();
      if (action === 'model') await runSetupWizard(config);
      else if (action === 'credentials') await runCredentialsWizard(config);
      else if (action === 'network') await runNetworkWizard(config);
      else if (action === 'permissions') await runPermissionsWizard(config);
      else if (action === 'advanced') await runAdvancedWizard(config);
      else await testConnection(config);
    });
  }
}

/** Each completed step persists explicitly; skipping or cancelling later steps does not undo it. */
async function setup(): Promise<void> {
  await runSetupWizard(loadConfig());
  for (;;) {
    const action = await menu('模型配置已保存，下一步想做什么？', [
      { value: 'connect', label: '连接我的 AI 助手', hint: 'Pi / Codex / ChatGPT Work / MCP' },
      { value: 'probe', label: '先测试模型连接', hint: '只发测试请求，不发记忆' },
      { value: 'permissions', label: '调整记忆权限', hint: '默认只允许个人记忆和你表达的内容' },
      { value: 'back', label: '先到这里，返回首页', hint: '已保存的配置会保留' },
    ]);
    if (action === 'back') return;
    await attempt(async () => {
      if (action === 'connect') await integrationsScreen();
      else if (action === 'permissions') await runPermissionsWizard(configured());
      else await testConnection(configured());
    });
  }
}

export async function runTui(): Promise<void> {
  requireInteractive();
  clack.intro('Common Memory · 让助手记住重要的事');
  log('↑↓ 选择 · Enter 确认 · 多选用空格 · Esc 返回，首页退出\n打开菜单不会调用模型。');
  let lastAction: string | undefined;
  for (;;) {
    const config = loadConfig();
    let action: string;
    try {
      action = await menu(config ? `想做什么？ · ${config.remote.model}${hasApiKey(config) ? '' : ' · 未设置密钥，可只读'}` : '欢迎！先配好模型，再连接你的助手。', config ? [
        { value: 'browse', label: '查看记忆', hint: '看看助手能读到什么' },
        { value: 'import', label: '导入 Markdown', hint: '把已有笔记交给模型整理' },
        { value: 'integrations', label: '连接 / 管理 AI 助手', hint: 'Pi、Codex、Work、MCP' },
        { value: 'projects', label: '项目与权限', hint: '添加项目，决定可读可写范围' },
        { value: 'settings', label: '模型与设置', hint: 'API Key、代理、连接测试' },
        { value: 'maintenance', label: '处理未完成任务', hint: '整理、重试、恢复' },
        { value: 'overview', label: '查看运行状态', hint: '进度和存储位置' },
        { value: 'exit', label: '退出' },
      ] : [{ value: 'setup', label: '开始设置', hint: '模型 → 连接助手，可随时跳过后续步骤' }, { value: 'exit', label: '暂时退出' }], config && lastAction !== 'setup' ? lastAction : undefined);
    } catch (error) { if (error instanceof UserCancelled) break; throw error; }
    if (action === 'exit') break;
    lastAction = action;
    await attempt(async () => {
      if (action === 'setup') await setup();
      else if (action === 'overview') await overview();
      else if (action === 'browse') await browseMemory(configured());
      else if (action === 'import') await importMarkdown(configured());
      else if (action === 'projects') await projectsScreen();
      else if (action === 'integrations') await integrationsScreen();
      else if (action === 'maintenance') await maintenanceScreen();
      else await settingsScreen();
    });
  }
  clack.outro('已退出。记忆和未完成的任务都还在。');
}
