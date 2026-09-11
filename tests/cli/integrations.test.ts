import { stubInstalledBuild } from '../helpers/installation-build.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installIntegrations, integrationHealth, readInstallationState, removeIntegrations } from '../../src/cli/integrations.js';
import { installationTransaction, readInstallationFile, writeInstallationFile } from '../../src/cli/installation-files.js';
import { scanIntegrationTargets, type IntegrationTarget } from '../../src/cli/integration-targets.js';

let root: string, home: string, dataRoot: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'cm-integrations-'))); home = join(root, 'common-memory'); dataRoot = join(home, 'data'); vi.stubEnv('COMMON_MEMORY_HOME', home); stubInstalledBuild(); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function target(id: 'codex' | 'chatgpt' | 'pi', hooks = id !== 'chatgpt'): IntegrationTarget { return { id, name: id, root: join(root, id === 'pi' ? 'pi' : 'codex'), mode: 'posix', hooks }; }
const install = (targets: IntegrationTarget[]) => installIntegrations(targets, dataRoot, { home });

it('installs and removes Pi automatically while preserving unrelated settings and all Memory data', () => {
  const pi = target('pi'); mkdirSync(pi.root); writeFileSync(join(pi.root, 'settings.json'), JSON.stringify({ theme: 'dark', extensions: ['/user/other.js'] }));
  mkdirSync(join(dataRoot, 'memory'), { recursive: true }); writeFileSync(join(dataRoot, 'memory/profile.md'), '# Keep\n');
  install([pi]);
  const wrapper = join(home, 'integrations/pi/common-memory.js');
  expect(JSON.parse(readFileSync(join(pi.root, 'settings.json'), 'utf8')).extensions).toEqual(['/user/other.js', wrapper]);
  expect(readFileSync(wrapper, 'utf8')).toContain('COMMON_MEMORY_HOME');
  expect(integrationHealth(readInstallationState()!, 'pi')).toBe(true);
  install([pi]); expect(JSON.parse(readFileSync(join(pi.root, 'settings.json'), 'utf8')).extensions).toHaveLength(2);
  removeIntegrations(['pi']);
  expect(JSON.parse(readFileSync(join(pi.root, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark', extensions: ['/user/other.js'] });
  expect(existsSync(wrapper)).toBe(false); expect(readFileSync(join(dataRoot, 'memory/profile.md'), 'utf8')).toBe('# Keep\n');
});
it('merges TOML without rewriting user comments and installs owned hooks and refresh skill', () => {
  const codex = target('codex'); mkdirSync(codex.root);
  const before = '# Keep this comment\nmodel = "unrelated"\n\n[mcp_servers.other]\ncommand = "other"\n';
  writeFileSync(join(codex.root, 'config.toml'), before);
  writeFileSync(join(codex.root, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] } }));
  install([codex]);
  const body = readFileSync(join(codex.root, 'config.toml'), 'utf8');
  expect(body.startsWith(before)).toBe(true); expect(parse(body).mcp_servers).toHaveProperty('common_memory');
  expect(body).toContain('"read"'); expect(body).not.toContain('"init"'); expect(body).not.toContain('dangerously');
  const hook = JSON.parse(readFileSync(join(codex.root, 'hooks.json'), 'utf8')); expect(hook.hooks.Stop).toHaveLength(2);
  expect(existsSync(join(codex.root, 'skills/memory-refresh/SKILL.md'))).toBe(true);
  removeIntegrations(['codex']);
  expect(readFileSync(join(codex.root, 'config.toml'), 'utf8')).toBe(before);
  expect(JSON.parse(readFileSync(join(codex.root, 'hooks.json'), 'utf8'))).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] } });
});
it('shares a read MCP resource but not Codex hooks between Codex CLI and Desktop', () => {
  const codex = target('codex'), desktop = target('chatgpt'); install([codex, desktop]);
  const state = readInstallationState()!;
  expect(state.resources.filter(r => r.kind === 'toml')).toHaveLength(1);
  expect(state.resources.find(r => r.kind === 'toml')!.owners).toEqual(['codex', 'chatgpt']);
  expect(state.resources.filter(r => r.kind === 'array').every(r => JSON.stringify(r.owners) === '["codex"]')).toBe(true);
  removeIntegrations(['codex']);
  expect(existsSync(join(codex.root, 'hooks.json'))).toBe(false); expect(integrationHealth(readInstallationState()!, 'chatgpt')).toBe(true);
  removeIntegrations(['chatgpt']); expect(existsSync(join(codex.root, 'config.toml'))).toBe(false);
});
it('read-only clients do not get unsupported hooks or import authority', () => {
  const codex = target('codex', false); install([codex]);
  expect(existsSync(join(codex.root, 'hooks.json'))).toBe(false);
  expect(readFileSync(join(codex.root, 'config.toml'), 'utf8')).not.toContain('memory_init');
});
it('preflights build availability and all selected clients before committing any of them', () => {
  const pi = target('pi'), codex = target('codex');
  stubInstalledBuild(false);
  expect(() => install([pi, codex])).toThrow('缺少构建产物');
  expect(readInstallationState()).toBeNull();
  expect(existsSync(join(pi.root, 'settings.json'))).toBe(false);
  stubInstalledBuild();
  mkdirSync(codex.root);
  writeFileSync(join(codex.root, 'config.toml'), '[mcp_servers.common_memory]\ncommand = "user-owned"\n');
  expect(() => install([pi, codex])).toThrow('未归属');
  expect(existsSync(join(pi.root, 'settings.json'))).toBe(false); expect(existsSync(join(home, 'integrations/pi/common-memory.js'))).toBe(false);
  expect(readInstallationState()).toBeNull();
});
it('does not override explicitly disabled hooks or malformed configs', () => {
  const codex = target('codex'); mkdirSync(codex.root); writeFileSync(join(codex.root, 'config.toml'), '[features]\nhooks=false\n');
  expect(() => install([codex])).toThrow('禁用 Hooks');
  writeFileSync(join(codex.root, 'config.toml'), '[[malformed'); expect(() => install([codex])).toThrow();
  expect(existsSync(join(codex.root, 'hooks.json'))).toBe(false);
});
it('uninstall preserves external edits and can resume after missing owned files', () => {
  const pi = target('pi'); install([pi]); const wrapper = join(home, 'integrations/pi/common-memory.js');
  const original = readFileSync(wrapper, 'utf8'); writeFileSync(wrapper, 'user-edited');
  expect(integrationHealth(readInstallationState()!, 'pi')).toBe(false);
  expect(() => removeIntegrations(['pi'])).toThrow('已被修改'); expect(readInstallationState()!.targets).toHaveLength(1);
  writeFileSync(wrapper, original); rmSync(wrapper); removeIntegrations(['pi']);
  expect(readInstallationState()!.targets).toHaveLength(0); expect(existsSync(join(pi.root, 'settings.json'))).toBe(false);
});
it('leaves unrelated changes made after installation intact', () => {
  const codex = target('codex', false); install([codex]); const path = join(codex.root, 'config.toml');
  writeFileSync(path, readFileSync(path, 'utf8') + '\n# Later\n[mcp_servers.other]\ncommand="other"\n');
  removeIntegrations(['codex']); expect(readFileSync(path, 'utf8')).toContain('# Later'); expect(parse(readFileSync(path, 'utf8')).mcp_servers).toEqual({ other: { command: 'other' } });
});
it.skipIf(process.platform === 'win32')('rejects symlink destinations before installing anything', () => {
  const other = join(root, 'other'); mkdirSync(other); symlinkSync(other, join(root, 'pi'));
  expect(() => install([target('pi')])).toThrow('不安全'); expect(existsSync(join(other, 'settings.json'))).toBe(false);
});
it('recovers a crash halfway through the multi-file transaction before starting another operation', () => {
  mkdirSync(home); const a = join(root, 'a'), b = join(root, 'b'); writeFileSync(a, 'old');
  writeInstallationFile(join(home, '.installation/transaction.json'), JSON.stringify([{ path: a, before: 'old', after: 'new' }, { path: b, before: null, after: 'created' }]));
  writeFileSync(a, 'new');
  installationTransaction(home, () => {});
  expect(readFileSync(a, 'utf8')).toBe('old'); expect(existsSync(b)).toBe(false); expect(existsSync(join(home, '.installation/transaction.json'))).toBe(false);
});
it('a recovery conflict preserves every file and the journal for retry', () => {
  mkdirSync(home); const a = join(root, 'a'); writeFileSync(a, 'outside-change');
  const journal = join(home, '.installation/transaction.json'); writeInstallationFile(journal, JSON.stringify([{ path: a, before: 'old', after: 'new' }]));
  expect(() => installationTransaction(home, () => {})).toThrow('外部修改'); expect(readFileSync(a, 'utf8')).toBe('outside-change'); expect(existsSync(journal)).toBe(true);
});
it('compares files again at commit instead of overwriting a concurrent client edit', () => {
  mkdirSync(home); const path = join(root, 'config'); writeFileSync(path, 'old');
  expect(() => installationTransaction(home, commit => { writeFileSync(path, 'outside'); commit([{ path, before: 'old', after: 'new' }]); })).toThrow('配置已变化');
  expect(readFileSync(path, 'utf8')).toBe('outside');
});
it('discovers supported POSIX clients and distinguishes incompatible capture versions', () => {
  const base = { home: root, env: { PATH: '', CODEX_HOME: join(root, 'custom-codex'), PI_CODING_AGENT_DIR: join(root, 'custom-pi') }, platform: 'linux' as const, executable: (name: string) => name === 'chatgpt' ? undefined : name, version: (path: string) => path === 'pi' ? '0.84.4' : 'codex-cli 0.154.0' };
  expect(scanIntegrationTargets(base)).toMatchObject([{ id: 'codex', root: join(root, 'custom-codex'), hooks: false }, { id: 'pi', root: join(root, 'custom-pi'), hooks: true }]);
  expect(scanIntegrationTargets({ ...base, version: () => 'unknown' }).map(t => t.id)).toEqual(['codex']);
});
it('discovers native Windows Desktop from an explicit app probe, not merely WSL presence', () => {
  const base = { home: root, env: { PATH: '', WSL_DISTRO_NAME: 'Synthetic' }, platform: 'linux' as const, executable: () => undefined };
  expect(scanIntegrationTargets({ ...base, windowsHome: () => undefined })).toEqual([]);
  const [desktop] = scanIntegrationTargets({ ...base, windowsHome: () => join(root, 'windows') });
  expect(desktop).toMatchObject({ id: 'chatgpt', mode: 'windows-wsl', hooks: false });
  installIntegrations([desktop!], dataRoot, { home, env: base.env });
  const body = readInstallationFile(join(desktop!.root, 'config.toml'))!;
  expect(body).toContain('wsl.exe'); expect(body).toContain('Synthetic'); expect(body).toContain('COMMON_MEMORY_HOME=');
});
