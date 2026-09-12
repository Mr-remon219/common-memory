import { stubInstalledBuild } from '../helpers/installation-build.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, loadConfig, saveConfig, type CommonMemoryConfig } from '../../src/config/config.js';
import { applicationRoot, installIntegrations, readInstallationState } from '../../src/cli/integrations.js';
import { assertDeletableData, npmInstallation, uninstallCompletely, withoutMemorySecrets } from '../../src/cli/uninstall.js';
import { RuntimeStore } from '../../src/v2/runtime.js';

let root: string, home: string, config: CommonMemoryConfig;
beforeEach(() => {
  stubInstalledBuild();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cm-uninstall-'))); home = join(root, 'common-memory');
  vi.stubEnv('HOME', root); vi.stubEnv('COMMON_MEMORY_HOME', home); vi.stubEnv('PATH', ''); vi.stubEnv('WSL_DISTRO_NAME', ''); vi.stubEnv('CODEX_HOME', join(root, 'codex')); vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'pi'));
  config = defaultConfig(); config.remote.model = 'synthetic'; config.remote.apiKeyEnv = 'TEST_KEY'; saveConfig(config); config = loadConfig()!;
  mkdirSync(join(config.dataRoot, 'memory'), { recursive: true }); writeFileSync(join(config.dataRoot, 'memory/profile.md'), '# Profile\n\n## Keep\nSynthetic data\n');
  writeFileSync(join(home, '.env'), 'TEST_KEY="synthetic-secret"\nOTHER_KEY="preserved"\n');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const installation = () => ({ node: process.execPath, npm: join(root, 'npm.js'), prefix: root, packageRoot: realpathSync(applicationRoot) });
const run = (deleteMemory: boolean, removePackage = vi.fn(async () => {})) => uninstallCompletely({ config, deleteMemory, clientsStopped: true, installation: installation(), removePackage });

it('full uninstall retains Markdown AND durable SQLite by default, removing only application credentials', async () => {
  const store = new RuntimeStore(config.dataRoot); store.enqueue({ sessionId: 's', entryId: 'e', scope: 'global', source: 'interactive', text: 'Pending user data', observedAt: new Date().toISOString() }); store.close();
  installIntegrations([{ id: 'pi', name: 'Pi', root: join(root, 'pi'), mode: 'posix', hooks: true }], config.dataRoot);
  const removePackage = vi.fn(async () => {});
  expect(await run(false, removePackage)).toEqual({ retained: config.dataRoot });
  expect(removePackage).toHaveBeenCalledTimes(1); expect(existsSync(join(home, 'config.json'))).toBe(false);
  expect(readFileSync(join(home, '.env'), 'utf8')).toBe('OTHER_KEY="preserved"\n');
  expect(readFileSync(join(config.dataRoot, 'memory/profile.md'), 'utf8')).toContain('Synthetic data'); expect(existsSync(join(config.dataRoot, 'runtime.sqlite'))).toBe(true);
  expect(readInstallationState()!.targets).toEqual([]);
});
it('deletes Memory only when separately requested and all clients were confirmed stopped', async () => {
  const removePackage = vi.fn(async () => {});
  await expect(uninstallCompletely({ config, deleteMemory: true, clientsStopped: false, installation: installation(), removePackage })).rejects.toThrow('先停止');
  expect(removePackage).not.toHaveBeenCalled(); expect(existsSync(config.dataRoot)).toBe(true);
  expect(await run(true, removePackage)).toEqual({ retained: null }); expect(existsSync(config.dataRoot)).toBe(false);
});
it('npm failure leaves configuration and all memory intact and reports partial integration removal', async () => {
  installIntegrations([{ id: 'pi', name: 'Pi', root: join(root, 'pi'), mode: 'posix', hooks: true }], config.dataRoot);
  await expect(run(true, vi.fn(async () => { throw new Error('private npm failure'); }))).rejects.toThrow('npm 卸载未完成');
  expect(readInstallationState()!.targets).toEqual([]); expect(loadConfig()).toEqual(config); expect(existsSync(config.dataRoot)).toBe(true); expect(readFileSync(join(home, '.env'), 'utf8')).toContain('synthetic-secret');
});
it('refuses source/npx self-removal instead of deleting a guessed global package', () => {
  // This suite runs from the checkout, never a global npm package.
  expect(() => npmInstallation()).toThrow(/全局 npm|npm 安装位置/);
});
it('data deletion refuses overlapping, shared and linked directories before removing the package', async () => {
  const removePackage = vi.fn(async () => {});
  const shared = join(config.dataRoot, 'unrelated.txt'); writeFileSync(shared, 'User file');
  await expect(run(true, removePackage)).rejects.toThrow('不属于 Common Memory'); expect(removePackage).not.toHaveBeenCalled();
  expect(readFileSync(shared, 'utf8')).toBe('User file');
  for (const path of [root, home, '/', applicationRoot]) expect(() => assertDeletableData({ ...config, dataRoot: path }, home)).toThrow();
});
it.skipIf(process.platform === 'win32')('refuses symlinks inside memory data rather than following or removing them', async () => {
  const other = join(root, 'outside'); mkdirSync(other); symlinkSync(other, join(config.dataRoot, 'memory/link'));
  const removePackage = vi.fn(async () => {});
  await expect(run(true, removePackage)).rejects.toThrow('链接'); expect(removePackage).not.toHaveBeenCalled(); expect(existsSync(other)).toBe(true);
});
it('refuses deleting a store with an active Writer lease', async () => {
  const store = new RuntimeStore(config.dataRoot); store.enqueue({ sessionId: 's', entryId: 'e', scope: 'global', source: 'interactive', text: 'Active work', observedAt: new Date().toISOString() }); store.claim({ force: true }); store.close();
  const removePackage = vi.fn(async () => {});
  await expect(run(true, removePackage)).rejects.toThrow('仍有记忆任务'); expect(removePackage).not.toHaveBeenCalled();
});
it('never removes configuration changed while the uninstall page was open', async () => {
  saveConfig({ ...config, writableScopes: [] }); const removePackage = vi.fn(async () => {});
  await expect(run(true, removePackage)).rejects.toThrow('配置已变化'); expect(removePackage).not.toHaveBeenCalled(); expect(existsSync(config.dataRoot)).toBe(true);
});
it('unmanaged legacy integrations block package removal instead of being silently orphaned', async () => {
  mkdirSync(join(root, 'pi')); writeFileSync(join(root, 'pi/settings.json'), JSON.stringify({ packages: ['npm:common-memory-core'] }));
  const removePackage = vi.fn(async () => {});
  await expect(run(false, removePackage)).rejects.toThrow('未由此安装器管理'); expect(removePackage).not.toHaveBeenCalled(); expect(loadConfig()).toEqual(config);
});
it('unmanaged profile launches block complete uninstall before removing managed custom-root ownership, including retries', async () => {
  const custom = join(root, 'old-custom-desktop');
  installIntegrations([{ id: 'chatgpt', name: 'ChatGPT', root: custom, mode: 'posix', hooks: false, init: true }], config.dataRoot);
  const profile = join(custom, 'legacy.config.toml');
  writeFileSync(profile, '[mcp_servers.common_memory_legacy]\ncommand="old-common-memory"\n');
  const state = readInstallationState(), removePackage = vi.fn(async () => {});
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(run(false, removePackage)).rejects.toThrow('未由此安装器管理');
    expect(removePackage).not.toHaveBeenCalled(); expect(readInstallationState()).toEqual(state);
    expect(existsSync(join(custom, 'config.toml'))).toBe(true);
    expect(readFileSync(profile, 'utf8')).toContain('common_memory_legacy');
  }
  rmSync(profile);
  await run(false, removePackage);
  expect(removePackage).toHaveBeenCalledTimes(1); expect(existsSync(join(custom, 'config.toml'))).toBe(false);
});
it('unmanaged base configuration also blocks removal before losing custom-root ownership', async () => {
  const custom = join(root, 'custom-desktop');
  installIntegrations([{ id: 'chatgpt', name: 'ChatGPT', root: custom, mode: 'posix', hooks: false }], config.dataRoot);
  const path = join(custom, 'config.toml'), body = readFileSync(path, 'utf8') + '\n[mcp_servers.common_memory_old]\ncommand="old"\n';
  writeFileSync(path, body); const state = readInstallationState(), removePackage = vi.fn(async () => {});
  await expect(run(false, removePackage)).rejects.toThrow('未由此安装器管理');
  expect(readInstallationState()).toEqual(state); expect(readFileSync(path, 'utf8')).toBe(body); expect(removePackage).not.toHaveBeenCalled();
});
it('private-env cleanup removes only exact managed assignments, not similarly named values', () => {
  expect(withoutMemorySecrets('export TEST_KEY=secret\nTEST_KEY_COPY=keep\n# keep comment\n', config)).toBe('TEST_KEY_COPY=keep\n# keep comment\n');
  expect(withoutMemorySecrets('TEST_KEY=secret\n', config)).toBeNull();
});
