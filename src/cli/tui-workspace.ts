import { loadConfig } from '../config/config.js';
import { readInstallationState, reconcileIntegrations } from './integrations.js';
import { listProjects } from './operations.js';
import { checkConfigUnchanged } from './tui-settings.js';
import { confirm, log, menu, note, UserCancelled } from './tui-prompts.js';

/** One physical client config has one read MCP, even when several frontends own it. */
export async function runWorkspaceWizard(): Promise<void> {
  const config = loadConfig(), prior = readInstallationState();
  if (!config) throw new Error('请先配置模型。');
  const hosts = prior?.targets.filter(t => t.id !== 'pi') ?? [];
  if (!hosts.length) { note('请先在 Agent Integration 安装受管 read MCP。Pi 与 Hooks 按 cwd 选择项目。', '固定工作区'); return; }
  const roots = [...new Set(hosts.map(t => t.root))];
  const root = await menu('选择受管 MCP 配置目录', [
    ...roots.map(value => ({ value, label: hosts.filter(t => t.root === value).map(t => t.name).join(' / '), hint: value })),
    { value: 'back', label: '返回' },
  ]);
  if (root === 'back') return;
  const owners = hosts.filter(t => t.root === root), current = owners[0]!.readWorkspace;
  const projects = listProjects(config);
  note(`配置目录：${root}\n全部受影响 owners：${owners.map(t => t.name).join(' / ')}\n当前 read MCP：${current ?? '仅 global'}${owners[0]!.readWorkspaceProjectId ? ` · project:${owners[0]!.readWorkspaceProjectId}` : ''}\nHooks / Pi 按每次 cwd；read MCP 固定启动范围，不跟随聊天 cwd。独立 init MCP 仍仅 global。\n绑定不增加读写授权；路径与项目 ID 一起固定。移除 / 重登记后原项目读取停止，global 不受影响，须重新确认绑定。`, '固定工作区');
  const workspace = await menu('read MCP 固定启动范围', [
    { value: 'global', label: '仅个人记忆（global）' },
    ...projects.map(p => ({ value: p.root, label: p.name, hint: `${p.root} · ${config.disclosure.allowedScopes.includes(`project:${p.id}`) ? '已授权读取' : '未授权读取，绑定不会授权'}` })),
    { value: 'back', label: '返回' },
  ], projects.some(p => p.root === current) ? current : 'global');
  if (workspace === 'back') return;
  const project = projects.find(p => p.root === workspace);
  if (workspace !== 'global' && !project) throw new Error('工作区未登记，未修改配置。');
  note(`拟选：${workspace === 'global' ? '仅 global' : workspace}\n实际读取：${[
    ...(config.disclosure.allowedScopes.includes('global') ? ['global'] : []),
    ...(project && config.disclosure.allowedScopes.includes(`project:${project.id}`) ? [`project:${project.id}`] : []),
  ].join(', ') || '无'}\n只改此目录的 read MCP 及上述全部 owners；其它目录不变。必须重启全部受影响宿主并新建会话，旧进程仍保留旧启动范围。`, '确认绑定');
  if (!await confirm('为上述全部 owners 保存固定绑定？')) throw new UserCancelled();
  checkConfigUnchanged(config);
  if (project && !listProjects(config).some(p => p.id === project.id && p.root === project.root)) throw new Error('项目登记已变化，请重新打开页面。');
  const targets = prior!.targets.map(t => {
    if (t.id === 'pi' || t.root !== root) return t;
    const { readWorkspace: _previous, readWorkspaceProjectId: _previousId, ...base } = t;
    return project ? { ...base, readWorkspace: project.root, readWorkspaceProjectId: project.id } : base;
  });
  reconcileIntegrations(targets, config.dataRoot, { expectedState: prior });
  log('固定绑定已保存；请重启全部受影响宿主并新建会话。Hooks 仍按 cwd，MCP 仍按启动范围。');
}
