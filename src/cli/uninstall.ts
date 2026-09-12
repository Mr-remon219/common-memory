import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { openDatabase } from '../v2/sqlite.js';
import { isDeepStrictEqual } from 'node:util';
import { configDirectory, configFilePath, envFilePath, loadConfig, type CommonMemoryConfig } from '../config/config.js';
import { PRIVATE_NETWORK_KEYS } from '../memory-manager/network/route.js';
import { applicationRoot, readInstallationState, removeIntegrations } from './integrations.js';
import { scanIntegrationTargets } from './integration-targets.js';
import { assertSafePath, installationTransaction, readInstallationFile } from './installation-files.js';

export interface NpmInstallation { node: string; npm: string; prefix: string; packageRoot: string }
const contains = (parent: string, child: string): boolean => {
  const path = relative(resolve(parent), resolve(child)); return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

/** Self-removal is allowed only for this exact global package in this Node/npm installation. */
export function npmInstallation(): NpmInstallation {
  const candidates = [join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'), join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  const npm = candidates.find(existsSync);
  if (!npm) throw new Error('无法确认当前 npm 安装位置；没有删除程序或数据。');
  const run = (args: string[]) => execFileSync(process.execPath, [npm, ...args], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let prefix: string, root: string;
  try { prefix = run(['prefix', '--global']); root = run(['root', '--global']); }
  catch { throw new Error('npm 安装位置检查失败，未执行卸载。'); }
  if (!isAbsolute(prefix) || !isAbsolute(root) || !existsSync(join(root, 'common-memory-core')) || realpathSync(join(root, 'common-memory-core')) !== realpathSync(applicationRoot)) {
    throw new Error('当前是源码、本地或 npx 安装，不是可确认的全局 npm 安装。可移除接入，但不会猜测删除程序目录。');
  }
  return { node: process.execPath, npm, prefix, packageRoot: realpathSync(applicationRoot) };
}

export function assertDeletableData(config: CommonMemoryConfig, home = configDirectory()): void {
  const root = resolve(config.dataRoot);
  assertSafePath(root);
  if (contains(root, home) || contains(root, homedir()) || contains(root, applicationRoot) || contains(applicationRoot, root)) throw new Error('数据路径与用户目录或程序目录重叠，拒绝删除。');
  if (!existsSync(root)) return;
  const expected = new Set(['memory', 'runtime', 'runtime.sqlite', 'runtime.sqlite-wal', 'runtime.sqlite-shm', 'runtime.sqlite-journal']);
  if (readdirSync(root).some(name => !expected.has(name))) throw new Error('数据目录包含不属于 Common Memory 的文件，拒绝整体删除。');
  const walk = (path: string) => {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || info.isFile() && info.nlink !== 1 || !info.isDirectory() && !info.isFile()) throw new Error('数据目录包含链接或特殊文件，拒绝删除。');
    if (info.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
  };
  walk(root);
  const database = join(root, 'runtime.sqlite');
  if (existsSync(database)) {
    const db = openDatabase(database, { readOnly: true, timeout: 100 });
    try {
      if (db.prepare("SELECT 1 FROM jobs WHERE state='running' AND expires>? LIMIT 1").get(Date.now())) throw new Error('仍有记忆任务运行中，请先停止客户端及后台任务。');
    } finally { db.close(); }
  }
}

/** Remove only configured Common Memory secrets; leave unrelated private assignments intact. */
export function withoutMemorySecrets(body: string | null, config: CommonMemoryConfig): string | null {
  if (body === null) return null;
  const names = new Set([config.remote.apiKeyEnv, ...PRIVATE_NETWORK_KEYS, ...(config.remote.caFileEnv ? [config.remote.caFileEnv] : [])]);
  const kept = body.split(/\r?\n/u).filter(line => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line);
    return !match || !names.has(match[1]!) && !/^COMMON_MEMORY_API_KEY_[A-F0-9]{32}$/u.test(match[1]!);
  }).join('\n');
  return kept.trim() ? kept : null;
}

/** Fail rather than leave a hand-installed hook/extension pointing at a removed package. */
function assertNoUnmanagedReferences(roots: string[]): void {
  const directories = new Set([...roots, resolve(process.env.CODEX_HOME || join(homedir(), '.codex')), resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent')), ...scanIntegrationTargets().map(t => t.root)]);
  for (const root of directories) for (const file of ['config.toml', 'hooks.json', 'settings.json']) {
    const body = readInstallationFile(join(root, file));
    if (body && /common-memory-core|common_memory|common-memory[./\\\s'"]/u.test(body)) throw new Error('检测到未由此安装器管理的 Common Memory 接入；保留程序和数据，避免留下失效客户端配置。');
  }
}

/** A requested data deletion needs its own confirmation AND stopped clients; npm failures stop cleanup. */
export async function uninstallCompletely(options: {
  config: CommonMemoryConfig;
  deleteMemory: boolean;
  clientsStopped: boolean;
  installation: NpmInstallation;
  removePackage?: (installation: NpmInstallation) => Promise<void>;
}): Promise<{ retained: string | null }> {
  if (!options.clientsStopped) throw new Error('请先停止所有客户端及 Common Memory 后台任务。');
  const home = configDirectory(), config = options.config;
  const beforeConfig = readInstallationFile(configFilePath());
  if (!isDeepStrictEqual(loadConfig(), config)) throw new Error('配置已变化，请重新打开卸载页面。');
  if (options.installation.packageRoot !== realpathSync(applicationRoot)) throw new Error('npm 包归属不匹配。');
  if (contains(options.installation.packageRoot, home) || contains(options.installation.packageRoot, config.dataRoot)) throw new Error('程序目录包含用户配置或记忆，拒绝 npm 卸载。');
  if (options.deleteMemory) assertDeletableData(config, home);
  const state = readInstallationState(home);
  removeIntegrations(state?.targets.map(t => t.id) ?? [], home);
  assertNoUnmanagedReferences(state?.targets.map(t => t.root) ?? []);
  const removePackage = options.removePackage ?? (async installation => {
    const current = npmInstallation();
    if (current.prefix !== installation.prefix || current.packageRoot !== installation.packageRoot || current.npm !== installation.npm || current.node !== installation.node) throw new Error('npm 安装位置已变化。');
    execFileSync(installation.node, [installation.npm, 'uninstall', '--global', '--prefix', installation.prefix, '--ignore-scripts', '--no-audit', '--no-fund', 'common-memory-core'], { timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
  });
  try { await removePackage(options.installation); }
  catch { throw new Error('npm 卸载未完成；已移除的接入不会恢复，配置和 Memory 数据仍保留。请检查 npm 后重试。'); }
  // All needed code has been loaded before npm removes this package.
  installationTransaction(home, commit => {
    if (readInstallationFile(configFilePath()) !== beforeConfig) throw new Error('程序已移除，但配置被外部修改；保留配置和数据。');
    const envPath = envFilePath(), beforeEnv = readInstallationFile(envPath);
    const stateFile = join(home, '.installation/state.json');
    commit([
      { path: stateFile, before: readInstallationFile(stateFile), after: JSON.stringify({ version: 1, setupComplete: false, targets: [], resources: [], dataRoot: config.dataRoot }) + '\n' },
      { path: configFilePath(), before: beforeConfig, after: null },
      { path: envPath, before: beforeEnv, after: withoutMemorySecrets(beforeEnv, config) },
    ]);
  });
  if (options.deleteMemory) {
    assertDeletableData(config, home);
    rmSync(config.dataRoot, { recursive: true, force: true });
    installationTransaction(home, commit => {
      const path = join(home, '.installation/state.json');
      commit([{ path, before: readInstallationFile(path), after: null }]);
    });
  }
  // The remaining administrative record is intentionally kept when data is retained: it remembers
  // a custom dataRoot and proves removed integration ownership without containing API keys.
  return { retained: options.deleteMemory ? null : config.dataRoot };
}
