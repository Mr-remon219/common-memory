import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { assertSafePath, readInstallationFile, type FileChange } from './installation-files.js';
import type { IntegrationId } from './integration-targets.js';

export interface MigrationResource {
  path: string;
  kind: 'file' | 'toml' | 'array';
  content?: string;
  keys?: string[];
  value?: unknown;
  owners: IntegrationId[];
}
export interface IntegrationMigrationCandidate {
  id: IntegrationId;
  path: string;
  kind: 'mcp' | 'hook' | 'pi';
  /** Structural locator only; never a command, environment or configuration body. */
  selector: string;
  /** Safe structural summaries displayed in the confirmation page. */
  before: string;
  after: string;
  status: 'actionable' | 'managed' | 'blocked';
  reason?: 'command-unverified' | 'toml-malformed' | 'json-malformed' | 'entry-unsupported' | 'selector-unsupported';
  summary: string;
}
export interface IntegrationMigrationPlan { candidates: IntegrationMigrationCandidate[]; changes: FileChange[] }

interface CandidatePatch { before: string; apply: (body: string) => string | null }
interface TomlHeader { name: string; start: number }
const patches = new WeakMap<IntegrationMigrationCandidate, CandidatePatch>();
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
/** A reference string is evidence only in a host's explicit launch/source field, never in arbitrary metadata. */
export const isCommonMemoryReference = (value: unknown): value is string => typeof value === 'string'
  && /(?:common-memory-core|(?:^|[\/\s'"])common-memory(?:[./\s'"]|$))/u.test(value);
export const hasCommonMemoryMcpLaunch = (server: unknown): boolean => object(server)
  && (isCommonMemoryReference(server.command) || Array.isArray(server.args) && server.args.some(isCommonMemoryReference));
export const hasCommonMemoryHookHandler = (handler: unknown): boolean => object(handler) && isCommonMemoryReference(handler.command);
export const hasCommonMemoryPiSource = (entry: unknown): boolean => isCommonMemoryReference(entry)
  || object(entry) && isCommonMemoryReference(entry.source);

function candidate(input: Omit<IntegrationMigrationCandidate, 'status' | 'before' | 'after'>, status: IntegrationMigrationCandidate['status'], patch?: CandidatePatch): IntegrationMigrationCandidate {
  const result: IntegrationMigrationCandidate = {
    ...input,
    before: input.selector,
    after: status === 'actionable' ? '移除该结构项' : status === 'managed' ? '保持已登记 ownership' : '保持不变',
    status,
  };
  if (patch) patches.set(result, patch);
  return result;
}
function parsedToml(body: string): Record<string, unknown> {
  const value: unknown = parseToml(body.replace(/^\ufeff/u, ''));
  if (!object(value)) throw new Error('迁移 TOML 不是对象。');
  return value;
}
/** Header recognition ignores lines inside TOML multiline strings; later semantic equality is the final guard. */
function tomlHeaders(body: string): TomlHeader[] {
  const result: TomlHeader[] = []; let offset = 0, multiline: '"""' | "'''" | undefined;
  for (const line of body.split(/(?<=\n)/u)) {
    if (multiline) {
      const count = line.split(multiline).length - 1;
      if (count % 2) multiline = undefined;
      offset += line.length; continue;
    }
    const triple = line.match(/"""|'''/u)?.[0] as '"""' | "'''" | undefined;
    if (triple && (line.split(triple).length - 1) % 2) { multiline = triple; offset += line.length; continue; }
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?\r?$/u.exec(line);
    if (header) result.push({ name: header[1]!.trim(), start: offset });
    offset += line.length;
  }
  return result;
}
function tableRange(body: string, table: string): [number, number] | undefined {
  const headers = tomlHeaders(body), index = headers.findIndex(header => header.name === table);
  if (index < 0) return;
  const end = headers.slice(index + 1).find(header => header.name !== table && !header.name.startsWith(`${table}.`))?.start ?? body.length;
  return [headers[index]!.start, end];
}
function removeTomlServer(body: string, name: string): string | null {
  const parsed = parsedToml(body), servers = object(parsed.mcp_servers) ? parsed.mcp_servers : undefined;
  if (!servers || !Object.hasOwn(servers, name)) throw new Error('迁移 MCP 配置项已变化，请重新扫描。');
  const selector = `mcp_servers.${name}`, range = tableRange(body, selector);
  if (!range) throw new Error('迁移 MCP 使用无法精确删除的 TOML 结构，请重新扫描。');
  const before = body.slice(0, range[0]), section = body.slice(range[0], range[1]), after = body.slice(range[1]);
  const begin = /# common-memory:([a-f0-9]{12})(:init)?:begin\r?\n$/iu.exec(before);
  const next = begin && new RegExp(`# common-memory:${begin[1]}${begin[2] ?? ''}:end\\r?\\n?\\s*$`, 'iu').test(section)
    ? body.slice(0, before.length - begin[0].length) + after : before + after;
  const expected = structuredClone(parsed);
  const expectedServers = expected.mcp_servers as Record<string, unknown>;
  delete expectedServers[name]; if (!Object.keys(expectedServers).length) delete expected.mcp_servers;
  if (!isDeepStrictEqual(parsedToml(next), expected)) throw new Error('迁移 MCP 删除不能证明仅移除了所选 server，请重新扫描。');
  return next.length ? next : null;
}
function arrayValue(document: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = document[key]; return Array.isArray(value) ? value : undefined;
}
function parsedJson(body: string): Record<string, unknown> {
  const value: unknown = JSON.parse(body.replace(/^\ufeff/u, ''));
  if (!object(value)) throw new Error('迁移配置不是 JSON 对象，请重新扫描。');
  return value;
}
function encodeJson(document: Record<string, unknown>): string | null {
  return Object.keys(document).length ? JSON.stringify(document, null, 2) + '\n' : null;
}
function removeJsonArrayValue(body: string, key: string, value: unknown): string | null {
  const document = parsedJson(body), values = arrayValue(document, key), index = values?.findIndex(item => isDeepStrictEqual(item, value)) ?? -1;
  if (index < 0) throw new Error('迁移配置项已变化，请重新扫描。');
  values!.splice(index, 1); if (!values!.length) delete document[key];
  return encodeJson(document);
}
/** Remove one concrete nested handler, retaining its outer matcher/options and all sibling handlers. */
function removeHookHandler(body: string, event: string, handler: unknown): string | null {
  const document = parsedJson(body);
  if (!object(document.hooks)) throw new Error('迁移 Hook 配置已变化，请重新扫描。');
  const entries = arrayValue(document.hooks, event);
  if (!entries) throw new Error('迁移 Hook 配置项已变化，请重新扫描。');
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = entries[entryIndex]; if (!object(entry) || !Array.isArray(entry.hooks)) continue;
    const handlerIndex = entry.hooks.findIndex(value => isDeepStrictEqual(value, handler));
    if (handlerIndex < 0) continue;
    entry.hooks.splice(handlerIndex, 1);
    if (!entry.hooks.length) entries.splice(entryIndex, 1);
    if (!entries.length) delete document.hooks[event];
    if (!Object.keys(document.hooks).length) delete document.hooks;
    return encodeJson(document);
  }
  throw new Error('迁移 Hook handler 已变化，请重新扫描。');
}
function managedToml(resources: MigrationResource[], path: string, body: string, selector: string): boolean {
  return resources.some(resource => resource.path === path && resource.kind === 'toml' && typeof resource.content === 'string'
    && resource.content.includes(`[${selector}]`) && body.includes(resource.content));
}
function managedHookHandler(resources: MigrationResource[], path: string, event: string, handler: unknown): boolean {
  return resources.some(resource => resource.path === path && resource.kind === 'array' && isDeepStrictEqual(resource.keys, ['hooks', event])
    && object(resource.value) && Array.isArray(resource.value.hooks) && resource.value.hooks.some(value => isDeepStrictEqual(value, handler)));
}
function managedArray(resources: MigrationResource[], path: string, keys: string[], value: unknown): boolean {
  return resources.some(resource => resource.path === path && resource.kind === 'array'
    && isDeepStrictEqual(resource.keys, keys) && isDeepStrictEqual(resource.value, value));
}
function scanToml(id: IntegrationId, path: string, body: string, resources: MigrationResource[]): IntegrationMigrationCandidate[] {
  let parsed: Record<string, unknown>;
  try { parsed = parsedToml(body); }
  catch { return isCommonMemoryReference(body) ? [candidate({ id, path, kind: 'mcp', selector: 'config.toml', reason: 'toml-malformed', summary: '无法解析的 Common Memory MCP 配置' }, 'blocked')] : []; }
  if (!object(parsed.mcp_servers)) return [];
  const result: IntegrationMigrationCandidate[] = [];
  for (const [name, server] of Object.entries(parsed.mcp_servers)) {
    const selector = `mcp_servers.${name}`, named = /^common_memory(?:_|$)/u.test(name), launch = hasCommonMemoryMcpLaunch(server);
    if (!named && !launch) continue;
    if (!launch) {
      result.push(candidate({ id, path, kind: 'mcp', selector, reason: 'command-unverified', summary: 'MCP 名称不足以验证 Common Memory command/args 启动引用' }, 'blocked'));
      continue;
    }
    if (!tableRange(body, selector)) {
      result.push(candidate({ id, path, kind: 'mcp', selector, reason: 'selector-unsupported', summary: 'MCP 使用无法精确删除的 TOML 结构' }, 'blocked'));
      continue;
    }
    const patch = { before: body, apply: (current: string) => removeTomlServer(current, name) };
    result.push(candidate({ id, path, kind: 'mcp', selector, summary: '可精确移除的 Common Memory MCP server' }, managedToml(resources, path, body, selector) ? 'managed' : 'actionable', patch));
  }
  return result;
}
function scanHooks(id: IntegrationId, path: string, body: string, resources: MigrationResource[]): IntegrationMigrationCandidate[] {
  let parsed: Record<string, unknown>;
  try { parsed = parsedJson(body); }
  catch { return isCommonMemoryReference(body) ? [candidate({ id, path, kind: 'hook', selector: 'hooks', reason: 'json-malformed', summary: '无法解析的 Common Memory Hook 配置' }, 'blocked')] : []; }
  if (!object(parsed.hooks)) return [];
  const result: IntegrationMigrationCandidate[] = [];
  for (const [event, entries] of Object.entries(parsed.hooks)) {
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, entryIndex) => {
      if (!object(entry) || !Array.isArray(entry.hooks)) return;
      entry.hooks.forEach((handler, handlerIndex) => {
        if (!hasCommonMemoryHookHandler(handler)) return;
        const selector = `hooks.${event}[${entryIndex}].hooks[${handlerIndex}]`;
        const patch = { before: body, apply: (current: string) => removeHookHandler(current, event, handler) };
        result.push(candidate({ id, path, kind: 'hook', selector, summary: '可精确移除的 Common Memory Hook command handler' }, managedHookHandler(resources, path, event, handler) ? 'managed' : 'actionable', patch));
      });
    });
  }
  return result;
}
function scanPi(id: IntegrationId, path: string, body: string, resources: MigrationResource[]): IntegrationMigrationCandidate[] {
  let parsed: Record<string, unknown>;
  try { parsed = parsedJson(body); }
  catch { return isCommonMemoryReference(body) ? [candidate({ id, path, kind: 'pi', selector: 'settings.json', reason: 'json-malformed', summary: '无法解析的 Common Memory Pi 配置' }, 'blocked')] : []; }
  const result: IntegrationMigrationCandidate[] = [];
  for (const key of ['extensions', 'packages'] as const) {
    const entries = parsed[key]; if (!Array.isArray(entries)) continue;
    entries.forEach((entry, index) => {
      const supported = typeof entry === 'string' || key === 'packages' && object(entry) && isCommonMemoryReference(entry.source);
      if (!supported || !hasCommonMemoryPiSource(entry)) return;
      const selector = `${key}[${index}]`, patch = { before: body, apply: (current: string) => removeJsonArrayValue(current, key, entry) };
      result.push(candidate({ id, path, kind: 'pi', selector, summary: `可精确移除的 Pi ${key} 注册项` }, managedArray(resources, path, [key], entry) ? 'managed' : 'actionable', patch));
    });
  }
  return result;
}

/** Read only explicit live registration keys. It never examines trust, sessions, credentials or arbitrary fields. */
export function discoverIntegrationCandidates(roots: { id: IntegrationId; root: string }[], options: { managed?: MigrationResource[] } = {}): IntegrationMigrationCandidate[] {
  const resources = options.managed ?? [], candidates: IntegrationMigrationCandidate[] = [], seen = new Set<string>();
  for (const { id, root } of roots) {
    assertSafePath(root);
    const files = id === 'pi' ? ['settings.json'] : ['config.toml', 'hooks.json', ...(existsSync(root) ? readdirSync(root).filter(name => name.endsWith('.config.toml')) : [])];
    for (const file of files) {
      const path = join(root, file); if (seen.has(path)) continue; seen.add(path);
      const body = readInstallationFile(path); if (body === null) continue;
      if (file.endsWith('.toml')) candidates.push(...scanToml(id, path, body, resources));
      else if (file === 'hooks.json') candidates.push(...scanHooks(id, path, body, resources));
      else candidates.push(...scanPi(id, path, body, resources));
    }
  }
  return candidates;
}

/** Build private FileChanges only after a caller has shown candidates and obtained confirmation. */
export function buildIntegrationMigrationPlan(candidates: IntegrationMigrationCandidate[]): IntegrationMigrationPlan {
  const blocked = candidates.filter(candidate => candidate.status === 'blocked');
  if (blocked.length) throw new Error(`无法安全迁移 ${blocked.map(candidate => candidate.path).join('、')}；请修复后重新扫描。`);
  const grouped = new Map<string, { before: string; patches: CandidatePatch[] }>();
  for (const candidate of candidates.filter(candidate => candidate.status === 'actionable')) {
    const patch = patches.get(candidate);
    if (!patch) throw new Error('迁移候选已失效，请重新扫描。');
    const group = grouped.get(candidate.path);
    if (group && group.before !== patch.before) throw new Error('迁移候选来自不一致的文件版本，请重新扫描。');
    if (group) group.patches.push(patch); else grouped.set(candidate.path, { before: patch.before, patches: [patch] });
  }
  const changes: FileChange[] = [];
  for (const [path, group] of grouped) {
    let after: string | null = group.before;
    for (const patch of group.patches) after = patch.apply(after ?? '');
    changes.push({ path, before: group.before, after });
  }
  return { candidates, changes };
}
