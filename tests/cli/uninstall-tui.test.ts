import * as clack from '@clack/prompts';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, saveConfig } from '../../src/config/config.js';
import { installIntegrations, readInstallationState } from '../../src/cli/integrations.js';
import { npmInstallation, uninstallCompletely } from '../../src/cli/uninstall.js';
import { runUninstallTui } from '../../src/cli/uninstall-tui.js';
import { UserCancelled } from '../../src/cli/tui-prompts.js';

vi.mock('@clack/prompts', () => ({ select: vi.fn(), multiselect: vi.fn(), confirm: vi.fn(), isCancel: (v: unknown) => typeof v === 'symbol', intro: vi.fn(), outro: vi.fn(), note: vi.fn(), log: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/cli/uninstall.js', () => ({ npmInstallation: vi.fn(), uninstallCompletely: vi.fn() }));
let home: string;
const originalIn = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), originalOut = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
beforeEach(() => {
  vi.resetAllMocks(); home = mkdtempSync(join(tmpdir(), 'cm-uninstall-tui-')); vi.stubEnv('COMMON_MEMORY_HOME', home);
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const config = defaultConfig(); config.remote.model = 'synthetic'; saveConfig(config);
  vi.mocked(npmInstallation).mockReturnValue({ node: process.execPath, npm: '/fake/npm', prefix: '/fake', packageRoot: '/fake/package' });
  vi.mocked(uninstallCompletely).mockResolvedValue({ retained: config.dataRoot });
});
afterEach(() => {
  vi.unstubAllEnvs(); for (const [stream, descriptor] of [[process.stdin, originalIn], [process.stdout, originalOut]] as const) { if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor); else Reflect.deleteProperty(stream, 'isTTY'); }
  rmSync(home, { recursive: true, force: true });
});
it('integration removal is a multiselect and keeps Core configuration and memory', async () => {
  installIntegrations([{ id: 'pi', name: 'Pi', root: join(home, 'pi'), mode: 'posix', hooks: true }], join(home, 'data'));
  vi.mocked(clack.select).mockResolvedValueOnce('integrations'); vi.mocked(clack.multiselect).mockResolvedValueOnce(['pi']);
  await runUninstallTui(); expect(readInstallationState()!.targets).toEqual([]); expect(existsSync(join(home, 'config.json'))).toBe(true);
  expect(clack.confirm).not.toHaveBeenCalled(); expect(uninstallCompletely).not.toHaveBeenCalled(); expect(clack.outro).toHaveBeenCalledWith('Done');
});
it('Memory Data confirmation defaults to keep, separate from Application/Integrations', async () => {
  vi.mocked(clack.select).mockResolvedValueOnce('complete');
  vi.mocked(clack.confirm).mockImplementation(async opts => { expect(opts.initialValue).toBe(false); return !opts.message.includes('永久删除'); });
  await runUninstallTui(); expect(uninstallCompletely).toHaveBeenCalledWith(expect.objectContaining({ deleteMemory: false, clientsStopped: true }));
  expect(clack.multiselect).not.toHaveBeenCalled(); expect(clack.confirm).toHaveBeenCalledTimes(2);
});
it('explicitly selected data deletion is passed separately to the backend', async () => {
  vi.mocked(clack.select).mockResolvedValueOnce('complete'); vi.mocked(clack.confirm).mockResolvedValue(true); vi.mocked(uninstallCompletely).mockResolvedValue({ retained: null });
  await runUninstallTui(); expect(uninstallCompletely).toHaveBeenCalledWith(expect.objectContaining({ deleteMemory: true }));
});
it('Esc on the data question cancels the operation without invoking uninstall', async () => {
  vi.mocked(clack.select).mockResolvedValueOnce('complete').mockResolvedValueOnce(Symbol('exit'));
  vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(Symbol('cancel'));
  await expect(runUninstallTui()).rejects.toBeInstanceOf(UserCancelled); expect(uninstallCompletely).not.toHaveBeenCalled(); expect(existsSync(join(home, 'config.json'))).toBe(true);
});
it('refused package ownership offers no destructive confirmation or false success', async () => {
  vi.mocked(clack.select).mockResolvedValueOnce('complete').mockResolvedValueOnce(Symbol('exit')); vi.mocked(npmInstallation).mockImplementation(() => { throw new Error('Not a global package'); });
  await expect(runUninstallTui()).rejects.toBeInstanceOf(UserCancelled); expect(clack.confirm).not.toHaveBeenCalled(); expect(uninstallCompletely).not.toHaveBeenCalled(); expect(clack.log.success).not.toHaveBeenCalled();
});
