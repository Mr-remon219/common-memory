import { stubInstalledBuild } from '../helpers/installation-build.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, loadConfig, saveConfig } from '../../src/config/config.js';
import { installIntegrations, integrationHealth, readInstallationState, reconcileIntegrations, removeIntegrations } from '../../src/cli/integrations.js';
import { scanIntegrationTargets, type IntegrationTarget } from '../../src/cli/integration-targets.js';

let home: string;
const target = (id: 'codex' | 'chatgpt', init = false): IntegrationTarget => ({ id, name: id, root: join(home, 'codex'), mode: 'posix', hooks: false, ...(init ? { init: true } : {}) });
const servers = () => parse(readFileSync(join(home, 'codex/config.toml'), 'utf8')).mcp_servers as Record<string, any>;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'cm-init-install-'))); vi.stubEnv('COMMON_MEMORY_HOME', home); stubInstalledBuild(); const config = defaultConfig(); config.remote.model = 'synthetic'; saveConfig(config);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

it('upgrades a read-only installation with an explicitly selected separate init server and can revoke it', () => {
  const config = loadConfig()!; installIntegrations([target('codex')], config.dataRoot);
  const before = readInstallationState()!, read = servers().common_memory;
  reconcileIntegrations([target('codex', true)], config.dataRoot, { expectedState: before, authorizeAgentImport: { expectedConfig: config } });
  expect(servers().common_memory).toEqual(read);
  expect(servers().common_memory_init).toMatchObject({ enabled_tools: ['memory_init', 'memory_status'], default_tools_approval_mode: 'approve' });
  expect(servers().common_memory_init.args).toContain('init'); expect(servers().common_memory_init.args).not.toContain('relay');
  expect(loadConfig()!.disclosure.allowedProvenance).toEqual(['user_explicit', 'agent_observation']);
  expect(loadConfig()!.writableScopes).toEqual(config.writableScopes);
  reconcileIntegrations([target('codex')], config.dataRoot);
  expect(servers()).toEqual({ common_memory: read });
  expect(loadConfig()!.disclosure.allowedProvenance).toContain('agent_observation'); // Unregistering a host is not global permission revocation.
});
it('host opt-in alone never silently grants Core disclosure permission', () => {
  const config = loadConfig()!; installIntegrations([target('chatgpt', true)], config.dataRoot);
  expect(loadConfig()).toEqual(config); expect(servers().common_memory_init).toBeDefined();
});
it('shares init only among explicit owners and keeps read-only owners when the last init owner leaves', () => {
  const config = loadConfig()!;
  installIntegrations([target('codex', true), target('chatgpt', true)], config.dataRoot);
  expect(readInstallationState()!.resources.filter(r => r.kind === 'toml')).toHaveLength(2);
  removeIntegrations(['codex']); expect(servers().common_memory_init).toBeDefined();
  installIntegrations([target('codex')], config.dataRoot);
  removeIntegrations(['chatgpt']); expect(Object.keys(servers())).toEqual(['common_memory']);
  expect(integrationHealth(readInstallationState()!, 'codex')).toBe(true);
  removeIntegrations(['codex']); expect(existsSync(join(home, 'codex/config.toml'))).toBe(false);
});
it('a conflicting init block rolls back disclosure approval and keeps all old ownership', () => {
  const config = loadConfig()!; installIntegrations([target('codex')], config.dataRoot); const state = readInstallationState();
  const path = join(home, 'codex/config.toml'); const body = readFileSync(path, 'utf8') + '\n[mcp_servers.common_memory_init]\ncommand="user-owned"\n'; writeFileSync(path, body);
  expect(() => reconcileIntegrations([target('codex', true)], config.dataRoot, { authorizeAgentImport: { expectedConfig: config } })).toThrow('未归属');
  expect(loadConfig()).toEqual(config); expect(readInstallationState()).toEqual(state); expect(readFileSync(path, 'utf8')).toBe(body);
});
it('rejects stale disclosure authorization and does not install partial host resources', () => {
  const config = loadConfig()!; saveConfig({ ...config, writableScopes: [] });
  expect(() => reconcileIntegrations([target('codex', true)], config.dataRoot, { authorizeAgentImport: { expectedConfig: config } })).toThrow('配置已被其他操作修改');
  expect(readInstallationState()).toBeNull(); expect(existsSync(join(home, 'codex/config.toml'))).toBe(false);
});
it('pins the same WSL runtime for separate read/init profiles and removes only the final init owner', () => {
  const config = loadConfig()!;
  const desktop = { ...target('chatgpt', true), mode: 'windows-wsl' as const };
  const codex = { ...target('codex', true), mode: 'windows-wsl' as const };
  installIntegrations([desktop, codex], config.dataRoot, { env: { WSL_DISTRO_NAME: 'Synthetic' } });
  const mcp = servers(), init = mcp.common_memory_init, read = mcp.common_memory;
  expect(init.command).toBe('C:\\Windows\\System32\\wsl.exe'); expect(init.command).toBe(read.command);
  expect(init.args.slice(0, init.args.indexOf('--client-id'))).toEqual(read.args.slice(0, read.args.indexOf('--client-id')));
  expect(init.args).toContain('Synthetic'); expect(init.args).toContain(`COMMON_MEMORY_HOME=${home}`);
  expect(init.args.slice(-5)).toEqual(['--client-id', 'common-memory-local-init', '--capability', 'init', '--global']);
  expect(read.args.slice(-5)).toEqual(['--client-id', 'common-memory-local', '--capability', 'read', '--global']);
  removeIntegrations(['chatgpt']); expect(servers().common_memory_init).toEqual(init);
  removeIntegrations(['codex']); expect(existsSync(join(home, 'codex/config.toml'))).toBe(false);
});
it('does not derive the macOS GUI home from a terminal-only Codex override and safely migrates old ownership', () => {
  const applications = join(home, 'Applications'); mkdirSync(join(applications, 'ChatGPT.app'), { recursive: true });
  const targets = scanIntegrationTargets({ platform: 'darwin', home, env: { CODEX_HOME: join(home, 'custom-cli') }, executable: name => name === 'codex' ? 'synthetic' : undefined, version: () => 'unknown', applications: [applications] });
  expect(targets).toMatchObject([{ id: 'codex', root: join(home, 'custom-cli') }, { id: 'chatgpt', root: join(home, '.codex') }]);
  const desktop = targets[1]!, old = { ...desktop, root: join(home, 'custom-cli') }, config = loadConfig()!;
  installIntegrations([old], config.dataRoot);
  reconcileIntegrations([desktop], config.dataRoot);
  expect(existsSync(join(old.root, 'config.toml'))).toBe(false); expect(existsSync(join(old.root, 'hooks.json'))).toBe(false);
  expect(integrationHealth(readInstallationState()!, 'chatgpt')).toBe(true);
  removeIntegrations(['chatgpt']); expect(existsSync(join(desktop.root, 'config.toml'))).toBe(false);
});
