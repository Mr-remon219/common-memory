import { stubInstalledBuild } from '../helpers/installation-build.js';
import * as clack from '@clack/prompts';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, loadConfig, saveConfig } from '../../src/config/config.js';
import { installIntegrations, integrationHealth, readInstallationState } from '../../src/cli/integrations.js';
import { scanIntegrationTargets, type IntegrationId, type IntegrationTarget } from '../../src/cli/integration-targets.js';
import { chooseIntegrations, integrationsScreen } from '../../src/cli/tui-integrations.js';
import { probeReadIntegration } from '../../src/cli/integration-probe.js';
import { UserCancelled } from '../../src/cli/tui-prompts.js';

vi.mock('@clack/prompts', () => ({ multiselect: vi.fn(), confirm: vi.fn(), isCancel: (v: unknown) => typeof v === 'symbol', note: vi.fn(), log: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/cli/integration-targets.js', () => ({ scanIntegrationTargets: vi.fn() }));
vi.mock('../../src/cli/integration-probe.js', () => ({ probeReadIntegration: vi.fn() }));
let home: string;
function target(id: IntegrationId): IntegrationTarget { return { id, name: id, root: join(home, id === 'pi' ? 'pi' : 'codex'), mode: 'posix', hooks: id !== 'chatgpt' }; }
beforeEach(() => {
  vi.resetAllMocks(); stubInstalledBuild();
  home = realpathSync(mkdtempSync(join(tmpdir(), 'cm-tui-integrations-'))); vi.stubEnv('COMMON_MEMORY_HOME', home); vi.stubEnv('OPENAI_API_KEY', 'synthetic');
  const config = defaultConfig(); config.remote.model = 'synthetic-model'; saveConfig(config);
  vi.mocked(scanIntegrationTargets).mockReturnValue([]);
  vi.mocked(clack.multiselect).mockResolvedValue([]);
  vi.mocked(probeReadIntegration).mockResolvedValue({ ok: true, code: 'READ_TOOLS_READY' });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

it('shows every agent, uses installed ownership for initial checks, and applies the final mixed selection', async () => {
  const config = loadConfig()!, pi = target('pi'), codex = target('codex'), chatgpt = target('chatgpt');
  installIntegrations([pi, codex], config.dataRoot);
  vi.mocked(scanIntegrationTargets).mockReturnValue([pi, codex, chatgpt]);
  vi.mocked(clack.multiselect).mockResolvedValueOnce(['pi', 'chatgpt']);
  await integrationsScreen();
  expect(clack.multiselect).toHaveBeenCalledWith(expect.objectContaining({
    message: 'Agent Integration', required: false, initialValues: ['pi', 'codex'],
    options: [expect.objectContaining({ value: 'pi', label: 'Pi' }), expect.objectContaining({ value: 'codex', label: 'Codex' }), expect.objectContaining({ value: 'chatgpt', label: 'ChatGPT' })],
  }));
  const state = readInstallationState()!;
  expect(state.targets.map(t => t.id)).toEqual(['pi', 'chatgpt']);
  expect(integrationHealth(state, 'pi')).toBe(true); expect(integrationHealth(state, 'chatgpt')).toBe(true);
  expect(existsSync(join(codex.root, 'hooks.json'))).toBe(false);
  expect(clack.log.success).toHaveBeenCalledWith('ChatGPT installed');
  expect(clack.log.success).not.toHaveBeenCalledWith('Pi installed');
});
it('shows unavailable agents disabled and permits setup with an empty selection', async () => {
  vi.mocked(clack.multiselect).mockResolvedValue([]);
  expect(await chooseIntegrations(loadConfig()!)).toBe(0);
  expect(clack.multiselect).toHaveBeenCalledWith(expect.objectContaining({ initialValues: [], options: [
    expect.objectContaining({ value: 'pi', disabled: true }), expect.objectContaining({ value: 'codex', disabled: true }), expect.objectContaining({ value: 'chatgpt', disabled: true }),
  ] }));
  expect(readInstallationState()).toMatchObject({ setupComplete: true, targets: [], resources: [] });
});
it('never records an unavailable agent even if the prompt returns its disabled value', async () => {
  vi.mocked(clack.multiselect).mockResolvedValueOnce(['chatgpt']);
  await expect(integrationsScreen()).rejects.toThrow('当前不可接入');
  expect(readInstallationState()).toBeNull();
  expect(clack.log.success).not.toHaveBeenCalled();
});
it('keeps a missing installed client selected and removable without rediscovering a replacement path', async () => {
  const pi = target('pi'); installIntegrations([pi], loadConfig()!.dataRoot);
  vi.mocked(clack.multiselect).mockResolvedValue([]);
  await integrationsScreen();
  expect(clack.multiselect).toHaveBeenCalledWith(expect.objectContaining({ initialValues: ['pi'], options: expect.arrayContaining([
    expect.objectContaining({ value: 'pi', disabled: false, hint: expect.stringContaining('当前未发现客户端') }),
  ]) }));
  expect(readInstallationState()!.targets).toEqual([]);
  expect(existsSync(join(pi.root, 'settings.json'))).toBe(false);
});
it('does not install detected clients automatically before the user selects them', async () => {
  vi.mocked(scanIntegrationTargets).mockReturnValue([target('pi'), target('codex')]);
  vi.mocked(clack.multiselect).mockResolvedValue([]);
  await integrationsScreen();
  expect(clack.multiselect).toHaveBeenCalledWith(expect.objectContaining({ initialValues: [] }));
  expect(readInstallationState()!.targets).toEqual([]);
});
it('cancelling the selection preserves all client files and installation state', async () => {
  installIntegrations([target('pi')], loadConfig()!.dataRoot); const before = readInstallationState();
  vi.mocked(clack.multiselect).mockResolvedValue(Symbol('cancel'));
  await expect(integrationsScreen()).rejects.toBeInstanceOf(UserCancelled);
  expect(readInstallationState()).toEqual(before); expect(integrationHealth(before!, 'pi')).toBe(true);
});
it('rejects a configuration edit made while the selection was open', async () => {
  const original = loadConfig()!; installIntegrations([target('pi')], original.dataRoot); const before = readInstallationState();
  vi.mocked(clack.multiselect).mockImplementation(async () => { saveConfig({ ...original, writableScopes: [] }); return []; });
  await expect(integrationsScreen()).rejects.toThrow('配置已被其他操作修改');
  expect(readInstallationState()).toEqual(before); expect(integrationHealth(before!, 'pi')).toBe(true);
  expect(loadConfig()!.writableScopes).toEqual([]);
});
it('rejects an installation ownership edit made while the selection was open', async () => {
  const config = loadConfig()!; installIntegrations([target('pi')], config.dataRoot);
  vi.mocked(clack.multiselect).mockImplementation(async () => { installIntegrations([target('codex')], config.dataRoot); return []; });
  await expect(integrationsScreen()).rejects.toThrow('接入状态已被其他操作修改');
  const state = readInstallationState()!;
  expect(state.targets.map(t => t.id)).toEqual(['pi', 'codex']); expect(integrationHealth(state, 'pi')).toBe(true); expect(integrationHealth(state, 'codex')).toBe(true);
  expect(clack.log.success).not.toHaveBeenCalled();
});
it('shows the unhealthy owned state and never reports unchanged broken integrations as installed', async () => {
  const pi = target('pi'); installIntegrations([pi], loadConfig()!.dataRoot);
  rmSync(join(home, 'integrations/pi/common-memory.js'));
  vi.mocked(clack.multiselect).mockResolvedValue(['pi']);
  await expect(integrationsScreen()).rejects.toThrow('接入文件缺失或已变更');
  expect(clack.multiselect).toHaveBeenCalledWith(expect.objectContaining({ initialValues: ['pi'], options: expect.arrayContaining([
    expect.objectContaining({ value: 'pi', hint: expect.stringContaining('接入文件缺失或已变更') }),
  ]) }));
  expect(clack.log.success).not.toHaveBeenCalled();
  expect(clack.log.info).not.toHaveBeenCalledWith('保留接入：Pi');
});
it('setup retries a rejected apply using the refreshed config, but propagates prompt failures', async () => {
  const config = loadConfig()!;
  vi.mocked(clack.multiselect)
    .mockImplementationOnce(async () => { saveConfig({ ...config, writableScopes: [] }); return []; })
    .mockResolvedValueOnce([]);
  expect(await chooseIntegrations(config, { retry: true })).toBe(0);
  expect(clack.multiselect).toHaveBeenCalledTimes(2);
  expect(clack.log.error).toHaveBeenCalledWith(expect.stringContaining('配置已被其他操作修改'));
  vi.mocked(clack.multiselect).mockRejectedValueOnce(new Error('Terminal disconnected'));
  await expect(chooseIntegrations(loadConfig()!, { retry: true })).rejects.toThrow('Terminal disconnected');
  expect(clack.multiselect).toHaveBeenCalledTimes(3);
});
it('explicit import selection authorizes disclosure and registers init in the same apply', async () => {
  const desktop = target('chatgpt'); vi.mocked(scanIntegrationTargets).mockReturnValue([desktop]);
  vi.mocked(clack.multiselect).mockResolvedValueOnce(['chatgpt']).mockResolvedValueOnce(['chatgpt']);
  vi.mocked(clack.confirm).mockResolvedValue(true);
  await integrationsScreen();
  expect(clack.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('agent_observation'), initialValue: false }));
  expect(loadConfig()!.disclosure.allowedProvenance).toContain('agent_observation');
  expect(readInstallationState()!.targets[0]!.init).toBe(true);
  expect(probeReadIntegration).toHaveBeenCalledTimes(1);
});
it.each([false, Symbol('cancel')])('declining or cancelling import consent preserves config and registrations', async answer => {
  const desktop = target('chatgpt'); vi.mocked(scanIntegrationTargets).mockReturnValue([desktop]);
  vi.mocked(clack.multiselect).mockResolvedValueOnce(['chatgpt']).mockResolvedValueOnce(['chatgpt']);
  vi.mocked(clack.confirm).mockResolvedValue(answer);
  const before = loadConfig();
  await expect(chooseIntegrations(before!, { retry: true })).rejects.toBeInstanceOf(UserCancelled);
  expect(loadConfig()).toEqual(before); expect(readInstallationState()).toBeNull();
  expect(probeReadIntegration).not.toHaveBeenCalled();
});
it('preserves existing init selection despite fresh discovery not carrying capability metadata', async () => {
  const desktop = target('chatgpt'); installIntegrations([{ ...desktop, init: true }], loadConfig()!.dataRoot);
  const config = loadConfig()!; saveConfig({ ...config, disclosure: { ...config.disclosure, allowedProvenance: ['user_explicit', 'agent_observation'] } });
  vi.mocked(scanIntegrationTargets).mockReturnValue([desktop]);
  vi.mocked(clack.multiselect).mockResolvedValueOnce(['chatgpt']).mockResolvedValueOnce(['chatgpt']);
  await integrationsScreen();
  expect(clack.multiselect).toHaveBeenLastCalledWith(expect.objectContaining({ initialValues: ['chatgpt'], message: expect.stringContaining('memory_init') }));
  expect(clack.confirm).not.toHaveBeenCalled(); expect(readInstallationState()!.targets[0]!.init).toBe(true);
});
it('does not register an init process that cannot start without a model key', async () => {
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.mocked(scanIntegrationTargets).mockReturnValue([target('codex')]);
  vi.mocked(clack.multiselect).mockResolvedValueOnce(['codex']).mockResolvedValueOnce(['codex']);
  await expect(integrationsScreen()).rejects.toThrow('memory_init 需要模型密钥');
  expect(readInstallationState()).toBeNull(); expect(loadConfig()!.disclosure.allowedProvenance).toEqual(['user_explicit']);
});
it('reports failed MCP startup separately from saved configuration, without a false connected claim', async () => {
  vi.mocked(scanIntegrationTargets).mockReturnValue([target('codex')]);
  vi.mocked(clack.multiselect).mockResolvedValueOnce(['codex']);
  vi.mocked(probeReadIntegration).mockResolvedValue({ ok: false, code: 'READ_MCP_FAILED' });
  await integrationsScreen();
  expect(readInstallationState()!.targets).toHaveLength(1);
  expect(clack.log.info).toHaveBeenCalledWith(expect.stringContaining('MCP 检查失败：READ_MCP_FAILED'));
  expect(clack.log.info).not.toHaveBeenCalledWith(expect.stringContaining('tools/list 通过'));
});
it('unchanged selection uses newly discovered capture capability to upgrade managed read-only Desktop',async()=>{
 const desktop=target('chatgpt');installIntegrations([desktop],loadConfig()!.dataRoot);
 vi.mocked(scanIntegrationTargets).mockReturnValue([{...desktop,hooks:true,hint:'Work capture'}]);vi.mocked(clack.multiselect).mockResolvedValueOnce(['chatgpt']);
 await integrationsScreen();expect(readInstallationState()!.targets[0]!.hooks).toBe(true);expect(existsSync(join(desktop.root,'hooks.json'))).toBe(true);
 expect(clack.log.info).toHaveBeenCalledWith(expect.stringContaining('/hooks'));
});
