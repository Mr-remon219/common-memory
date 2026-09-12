import { execFileSync } from 'node:child_process';
import { HOST_HOOK_EVENTS, hostHookHandler, renderHostCommand, renderWindowsBridge } from './work-config.js';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseTomlDocument, stringify as stringifyToml } from 'smol-toml';
import { configDirectory } from '../config/config.js';
import type { LaunchOptions } from './host-launch.js';
import { installationTransaction, readInstallationFile, type FileChange } from './installation-files.js';
import type { IntegrationId, IntegrationTarget } from './integration-targets.js';

export const applicationRoot = fileURLToPath(new URL('../../', import.meta.url));
interface Resource {
  path: string;
  kind: 'file' | 'toml' | 'array';
  content?: string;
  keys?: string[];
  value?: unknown;
  owners: IntegrationId[];
}
export interface InstallationState {
  version: 1;
  setupComplete: boolean;
  dataRoot?: string;
  targets: IntegrationTarget[];
  resources: Resource[];
}
const statePath = (home: string) => join(home, '.installation/state.json');
const emptyState = (): InstallationState => ({ version: 1, setupComplete: false, targets: [], resources: [] });
const integrationIds = ['codex', 'chatgpt', 'pi'];
// Preserve exact BOM bytes for ownership/rollback; ignore the marker only for semantic parsing.
const parseToml = (body:string,options?:Parameters<typeof parseTomlDocument>[1]) => parseTomlDocument(body.replace(/^\ufeff/u,''),options);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export function readInstallationState(home = configDirectory()): InstallationState | null {
  const raw = readInstallationFile(statePath(home));
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw.replace(/^\ufeff/u,''));
  if (!object(value) || value.version !== 1 || typeof value.setupComplete !== 'boolean' || !Array.isArray(value.targets) || !Array.isArray(value.resources)
    || value.dataRoot !== undefined && (typeof value.dataRoot !== 'string' || !isAbsolute(value.dataRoot))) throw new Error('安装记录损坏，未修改任何客户端。');
  for (const target of value.targets) if (!object(target) || !integrationIds.includes(String(target.id)) || typeof target.name !== 'string' || typeof target.root !== 'string' || !isAbsolute(target.root) || !['posix', 'windows-wsl'].includes(String(target.mode)) || typeof target.hooks !== 'boolean') throw new Error('客户端安装记录损坏。');
  for (const resource of value.resources) {
    if (!object(resource) || typeof resource.path !== 'string' || !isAbsolute(resource.path) || !['file', 'toml', 'array'].includes(String(resource.kind)) || !Array.isArray(resource.owners) || !resource.owners.length || resource.owners.some(id => !integrationIds.includes(String(id)))) throw new Error('安装文件归属记录损坏。');
    if (resource.kind !== 'array' && typeof resource.content !== 'string') throw new Error('安装内容记录损坏。');
    if (resource.kind === 'array' && (!Array.isArray(resource.keys) || !resource.keys.length || resource.keys.some(k => typeof k !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(k)))) throw new Error('安装配置项记录损坏。');
  }
  return value as unknown as InstallationState;
}

function parseJson(raw: string | null): Record<string, unknown> {
  const value: unknown = raw === null ? {} : JSON.parse(raw.replace(/^\ufeff/u,''));
  if (!object(value)) throw new Error('客户端配置不是 JSON 对象，未覆盖。');
  return value;
}
function arrayAt(document: Record<string, unknown>, keys: string[], create: boolean): unknown[] | undefined {
  let cursor = document;
  for (const key of keys.slice(0, -1)) {
    if (!Object.hasOwn(cursor, key)) { if (!create) return; cursor[key] = {}; }
    if (!object(cursor[key])) throw new Error('客户端配置结构冲突。');
    cursor = cursor[key] as Record<string, unknown>;
  }
  const key = keys.at(-1)!;
  if (!Object.hasOwn(cursor, key)) { if (!create) return; cursor[key] = []; }
  if (!Array.isArray(cursor[key])) throw new Error('客户端配置项不是列表，未覆盖。');
  return cursor[key] as unknown[];
}
function sameResource(a: Resource, b: Resource): boolean {
  return a.path === b.path && a.kind === b.kind && a.content === b.content && isDeepStrictEqual(a.keys, b.keys) && isDeepStrictEqual(a.value, b.value);
}
function resourcePresent(resource: Resource, raw: string | null): boolean {
  if (resource.kind === 'file') return raw === resource.content;
  if (resource.kind === 'toml') return raw !== null && raw.includes(resource.content!);
  return arrayAt(parseJson(raw), resource.keys!, false)?.some(value => isDeepStrictEqual(value, resource.value)) ?? false;
}
export function integrationHealth(state: InstallationState, id: IntegrationId): boolean {
  const resources = state.resources.filter(r => r.owners.includes(id));
  return resources.length > 0 && resources.every(r => {
    try { return resourcePresent(r, readInstallationFile(r.path)); } catch { return false; }
  });
}

function desiredResources(target: IntegrationTarget, home: string, env: NodeJS.ProcessEnv): Resource[] {
  const owner = [target.id], cli = join(applicationRoot, 'dist/cli/main.js');
  if (target.id === 'pi') {
    const wrapper = join(home, 'integrations/pi/common-memory.js');
    const extension = pathToFileURL(join(applicationRoot, 'dist/pi-extension/index.js')).href;
    const body = `// Common Memory managed integration\nimport { resolve } from 'node:path';\nexport default async function(pi) {\n  const home = ${JSON.stringify(home)};\n  if (process.env.COMMON_MEMORY_HOME && resolve(process.env.COMMON_MEMORY_HOME) !== home) throw new Error('Common Memory home conflicts with the installed Pi integration');\n  process.env.COMMON_MEMORY_HOME = home;\n  const { default: extension } = await import(${JSON.stringify(extension)});\n  return extension(pi);\n}\n`;
    return [
      { kind: 'file', path: join(home, 'integrations/pi/package.json'), content: '{"private":true,"type":"module"}\n', owners: owner },
      { kind: 'file', path: wrapper, content: body, owners: owner },
      { kind: 'array', path: join(target.root, 'settings.json'), keys: ['extensions'], value: wrapper, owners: owner },
    ];
  }
  let command = process.execPath;
  let args = [cli, 'mcp', '--client-id', 'common-memory-local', '--capability', 'read', '--global'];
  let environment: Record<string, string> | undefined = { COMMON_MEMORY_HOME: home };
  if (target.mode === 'windows-wsl') {
    if (!env.WSL_DISTRO_NAME) throw new Error('无法确定当前 WSL 发行版，未写入 Windows 客户端。');
    command = 'C:\\Windows\\System32\\wsl.exe';
    args = ['-d', env.WSL_DISTRO_NAME, '-u', userInfo().username, '-e', '/usr/bin/env', `COMMON_MEMORY_HOME=${home}`, process.execPath, ...args];
    environment = undefined;
  }
  const tag = createHash('sha256').update(home).digest('hex').slice(0, 12);
  const config = stringifyToml({ mcp_servers: { common_memory: { command, args, ...(environment ? { env: environment } : {}), enabled_tools: ['memory_read', 'memory_status'] } } });
  const resources: Resource[] = [{ kind: 'toml', path: join(target.root, 'config.toml'), content: `\n# common-memory:${tag}:begin\n${config}# common-memory:${tag}:end\n`, owners: owner }];
  if (target.hooks) {
    const launch:LaunchOptions={wsl:target.mode==='windows-wsl',cli};
    const launchEnv={...env,COMMON_MEMORY_HOME:home};
    const bridge=join(target.root,'common-memory-bridge.ps1');
    const nativeBridge=launch.wsl?execFileSync('/usr/bin/wslpath',['-w',bridge],{encoding:'utf8',timeout:3000}).trim():undefined;
    // Native scripts must live on a Windows drive, not an arbitrary WSL UNC path.
    if(launch.wsl&&(!nativeBridge||!win32.isAbsolute(nativeBridge)||! /^[A-Za-z]:\\/u.test(nativeBridge)))throw new Error('Windows bridge requires a native Windows config directory');
    if(launch.wsl)resources.push({kind:'file',path:bridge,content:'\ufeff'+renderWindowsBridge(launch,launchEnv),owners:owner});
    const hook = renderHostCommand('codex','codex-hook',launch,launchEnv,nativeBridge);
    for (const event of HOST_HOOK_EVENTS) {
      resources.push({ kind: 'array', path: join(target.root, 'hooks.json'), keys: ['hooks', event], value: { hooks: [hostHookHandler(event,hook)] }, owners: owner });
    }
    const refresh = renderHostCommand('codex','session-refresh',launch,launchEnv,nativeBridge);
    resources.push({ kind: 'file', path: join(target.root, 'skills/memory-refresh/SKILL.md'), content: `---\nname: memory-refresh\ndescription: Explicitly refresh the current Common Memory snapshot.\n---\n\nWhen the user invokes this skill, run:\n\n\`\`\`sh\n${refresh}\n\`\`\`\n\nReport failures. Do not reset memory or session state.\n`, owners: owner },
      { kind: 'file', path: join(target.root, 'skills/memory-refresh/agents/openai.yaml'), content: 'policy:\n  allow_implicit_invocation: false\n', owners: owner });
  }
  return resources;
}

function hasCaptureCommand(value:unknown):boolean {
  if(typeof value==='string') {
    if(/(?:codex-hook|work-hook|common-memory)/u.test(value))return true;
    const encoded=/-EncodedCommand ([A-Za-z0-9+/=]+)/iu.exec(value)?.[1];
    return encoded!==undefined && /(?:codex-hook|work-hook|common-memory)/u.test(Buffer.from(encoded,'base64').toString('utf16le'));
  }
  return Array.isArray(value)?value.some(hasCaptureCommand):object(value)&&Object.values(value).some(hasCaptureCommand);
}

interface IntegrationPlan {
  get: (path: string) => string | null;
  put: (path: string, after: string | null) => void;
  changes: Map<string, FileChange>;
}
function integrationPlan(): IntegrationPlan {
  const changes = new Map<string, FileChange>();
  const get = (path: string): string | null => {
    if (!changes.has(path)) {
      const before = readInstallationFile(path);
      changes.set(path, { path, before, after: before });
    }
    return changes.get(path)!.after;
  };
  return { changes, get, put: (path, after) => {
    get(path); const change = changes.get(path)!; change.after = after;
    // Finalize state last, after its client resources, while preserving the first-read baseline.
    changes.delete(path); changes.set(path, change);
  } };
}

/** Stage semantic JSON additions and exact TOML fragments without changing unrelated settings. */
function stageInstall(state: InstallationState, targets: IntegrationTarget[], home: string, env: NodeJS.ProcessEnv, plan: IntegrationPlan): void {
  const { get, put } = plan;
  for (const target of targets) {
    const desired = desiredResources(target, home, env);
    if (!existsSync(join(applicationRoot,'dist/cli/main.js')) && desired.some(r=>!state.resources.some(owned=>sameResource(owned,r)))) throw new Error('缺少构建产物，请安装完整的 Common Memory 包。');
    if(target.hooks && target.id!=='pi') {
      const config=parseToml(get(join(target.root,'config.toml'))??'',{integersAsBigInt:true});
      const hooks=parseJson(get(join(target.root,'hooks.json')));
      const check=(value:unknown,path:string,keys:string[])=>{
        if (!Array.isArray(value)) return;
        for(const entry of value) {
          if(state.resources.some(r=>r.path===path&&r.kind==='array'&&isDeepStrictEqual(r.keys,keys)&&isDeepStrictEqual(r.value,entry)))continue;
          if(hasCaptureCommand(entry))throw new Error('已有未归属的 Common Memory Hook，未重复安装。');
        }
      };
      for(const [document,path] of [[config,join(target.root,'config.toml')],[hooks,join(target.root,'hooks.json')]] as const)
        if(object(document.hooks))for(const [event,entries] of Object.entries(document.hooks))check(entries,path,['hooks',event]);
    }
    // Different runtimes cannot share a client config: do not break a native/WSL installation.
    if (state.targets.some(t => t.root === target.root && t.mode !== target.mode) || targets.some(t => t.root === target.root && t.mode !== target.mode)) throw new Error('Windows 与 WSL 客户端正在共用配置目录，无法安全自动合并。');
    for (const resource of desired) {
      const owned = state.resources.find(r => sameResource(r, resource));
      const raw = get(resource.path);
      if (resource.kind === 'toml' && target.hooks) {
        const parsed = parseToml(raw ?? '', { integersAsBigInt: true });
        if (object(parsed.features) && parsed.features.hooks === false) throw new Error('客户端已明确禁用 Hooks，未改变该安全设置。');
      }
      if (owned) {
        if (!resourcePresent(owned, raw)) throw new Error(`已安装的 Common Memory 配置被修改，未覆盖：${resource.path}`);
        if (!owned.owners.includes(target.id)) owned.owners.push(target.id);
        continue;
      }
      if (resource.kind === 'file') {
        if (raw !== null) throw new Error(`目标文件已存在且不属于本次安装：${resource.path}`);
        put(resource.path, resource.content!);
      } else if (resource.kind === 'toml') {
        const parsed = parseToml(raw ?? '', { integersAsBigInt: true });
        if (object(parsed.mcp_servers) && Object.keys(parseToml(resource.content!).mcp_servers as object).some(name=>Object.hasOwn(parsed.mcp_servers as object,name))) throw new Error('已有未归属的 common_memory MCP 配置，未覆盖。');
        const next = (raw ?? '') + resource.content!;
        parseToml(next, { integersAsBigInt: true }); put(resource.path, next);
      } else {
        const document = parseJson(raw), array = arrayAt(document, resource.keys!, true)!;
        if (array.some(value => isDeepStrictEqual(value, resource.value))) throw new Error('已有同名未归属接入项，未重复安装。');
        if (target.id === 'pi' && JSON.stringify(document).includes('common-memory-core')) throw new Error('Pi 已有手动安装的 Common Memory 包，未重复加载。');
        array.push(resource.value); put(resource.path, JSON.stringify(document, null, 2) + '\n');
      }
      state.resources.push({ ...resource, owners: [...resource.owners] });
    }
    state.targets = [...state.targets.filter(t => t.id !== target.id), target];
  }
}

function stageRemove(state: InstallationState, ids: IntegrationId[], home: string, plan: IntegrationPlan): void {
  const { get, put } = plan;
  for (const resource of state.resources) {
    if (!resource.owners.some(id => ids.includes(id))) continue;
    resource.owners = resource.owners.filter(id => !ids.includes(id));
    if (resource.owners.length) {
      if (!resourcePresent(resource, get(resource.path))) throw new Error(`共享接入文件缺失或已变更，未修改任何接入：${resource.path}`);
      continue;
    }
    const raw = get(resource.path);
    if (raw === null) continue;
    let next: string | null;
    if (resource.kind === 'file') {
      if (raw !== resource.content) throw new Error(`安装文件已被修改，未删除：${resource.path}`);
      next = null;
    } else if (resource.kind === 'toml') {
      if (!raw.includes(resource.content!)) throw new Error(`MCP 配置块已被修改，未删除：${resource.path}`);
      next = raw.replace(resource.content!, ''); parseToml(next, { integersAsBigInt: true });
      if (!next.length) next = null;
    } else {
      const document = parseJson(raw), array = arrayAt(document, resource.keys!, false);
      const index = array?.findIndex(value => isDeepStrictEqual(value, resource.value)) ?? -1;
      if (index >= 0) array!.splice(index, 1);
      else if (raw.includes(home)) throw new Error(`接入项已被修改，未删除：${resource.path}`);
      else continue; // Already manually removed.
      // Remove now-empty managed containers, never unrelated values.
      for (let depth = resource.keys!.length; depth > 0; depth--) {
        let parent = document;
        for (const key of resource.keys!.slice(0, depth - 1)) parent = parent[key] as Record<string, unknown>;
        const key = resource.keys![depth - 1]!, value = parent[key];
        if (Array.isArray(value) ? value.length === 0 : object(value) && Object.keys(value).length === 0) delete parent[key];
        else break;
      }
      next = Object.keys(document).length ? JSON.stringify(document, null, 2) + '\n' : null;
    }
    put(resource.path, next);
  }
  state.resources = state.resources.filter(r => r.owners.length);
  state.targets = state.targets.filter(t => !ids.includes(t.id));
}

/** Additive API retained for package consumers and explicit installation operations. */
export function installIntegrations(targets: IntegrationTarget[], dataRoot: string, options: { home?: string; env?: NodeJS.ProcessEnv } = {}): void {
  const home = resolve(options.home ?? configDirectory()), env = options.env ?? process.env;
  installationTransaction(home, commit => {
    const plan = integrationPlan(); plan.get(statePath(home));
    const state = readInstallationState(home) ?? emptyState();
    stageInstall(state, targets, home, env, plan);
    state.setupComplete = true; state.dataRoot = dataRoot;
    plan.put(statePath(home), JSON.stringify(state, null, 2) + '\n');
    commit([...plan.changes.values()]);
  });
}

export function removeIntegrations(ids: IntegrationId[], home = configDirectory()): void {
  installationTransaction(home, commit => {
    const plan = integrationPlan(); plan.get(statePath(home));
    const state = readInstallationState(home);
    if (!state) return;
    stageRemove(state, ids, home, plan);
    plan.put(statePath(home), JSON.stringify(state, null, 2) + '\n');
    commit([...plan.changes.values()]);
  });
}

export interface IntegrationChanges { installed: IntegrationId[]; removed: IntegrationId[]; retained: IntegrationId[] }

/** Apply the final selected state in one recoverable transaction, keeping unchanged integrations intact. */
export function reconcileIntegrations(targets: IntegrationTarget[], dataRoot: string, options: {
  home?: string; env?: NodeJS.ProcessEnv; expectedState?: InstallationState | null;
} = {}): IntegrationChanges {
  const home = resolve(options.home ?? configDirectory()), env = options.env ?? process.env;
  return installationTransaction(home, commit => {
    const plan = integrationPlan(); plan.get(statePath(home));
    const previous = readInstallationState(home);
    if (options.expectedState !== undefined && !isDeepStrictEqual(previous, options.expectedState)) throw new Error('Agent 接入状态已被其他操作修改，请重新打开页面后再试。');
    const state = previous ?? emptyState();
    if (new Set(targets.map(t => t.id)).size !== targets.length) throw new Error('Agent 选择包含重复项。');
    const removed = state.targets.filter(t => !targets.some(selected => selected.id === t.id)).map(t => t.id);
    const added = targets.filter(t => !state.targets.some(installed => installed.id === t.id));
    const retained = targets.filter(t => state.targets.some(installed => installed.id === t.id)).map(t => t.id);
    for (const id of retained) {
      if (!integrationHealth(state, id)) throw new Error(`${id} 的接入文件缺失或已变更，未修改任何接入。请先恢复被修改的文件；仅缺失文件的接入可取消选择移除。`);
    }
    // Transfer shared ownership before removing old owners so a Codex → ChatGPT switch keeps its MCP block.
    const desired=targets.flatMap(target=>desiredResources(target,home,env));
    for(const resource of [...state.resources]) {
      if(desired.some(wanted=>sameResource(resource,wanted)))continue;
      // Final-owner removal uses the same exact-content safeguards as uninstall.
      stageRemove({...state,resources:[{...resource,owners:[...resource.owners]}]},resource.owners,home,plan);
      state.resources=state.resources.filter(r=>r!==resource);
    }
    // Reconcile retained metadata and missing resources, not just newly selected products.
    stageInstall(state, targets, home, env, plan);
    stageRemove(state, removed, home, plan);
    for(const resource of state.resources)resource.owners=resource.owners.filter(id=>desired.some(r=>r.owners.includes(id)&&sameResource(r,resource)));
    state.setupComplete = true; state.dataRoot = dataRoot;
    plan.put(statePath(home), JSON.stringify(state, null, 2) + '\n');
    commit([...plan.changes.values()]);
    return { installed: added.map(t => t.id), removed, retained };
  });
}
