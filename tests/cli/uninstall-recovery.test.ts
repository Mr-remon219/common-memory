import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applicationRoot, installIntegrations, readInstallationState } from '../../src/cli/integrations.js';
import { uninstallWithUnreadableConfig } from '../../src/cli/uninstall.js';
import { stubInstalledBuild } from '../helpers/installation-build.js';

let root: string, home: string, data: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cm-uninstall-recovery-'))); home = join(root, 'home'); data = join(root, 'data');
  vi.stubEnv('COMMON_MEMORY_HOME', home); vi.stubEnv('HOME', root); vi.stubEnv('PATH', ''); vi.stubEnv('CODEX_HOME', join(root, 'codex')); vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'pi')); stubInstalledBuild();
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const installation = () => ({ node: process.execPath, npm: '/fake/npm', prefix: '/fake', packageRoot: realpathSync(applicationRoot) });

it('with an unreadable config removes only exact owned integrations and the confirmed application while retaining config, credentials and memory', async () => {
  const pi = join(root, 'pi'); installIntegrations([{ id: 'pi', name: 'Pi', root: pi, mode: 'posix', hooks: true }], data, { home });
  writeFileSync(join(home, 'config.json'), '{invalid'); writeFileSync(join(home, '.env'), 'SECRET=preserve\n');
  mkdirSync(data, { recursive: true }); writeFileSync(join(data, 'memory.md'), 'keep');
  const beforeRemove = vi.fn(async () => {}), removePackage = vi.fn(async () => {});
  await uninstallWithUnreadableConfig({ beforeRemove, installation: installation(), removePackage });
  expect(beforeRemove).toHaveBeenCalledOnce(); expect(removePackage).toHaveBeenCalledOnce();
  expect(beforeRemove.mock.invocationCallOrder[0]!).toBeLessThan(removePackage.mock.invocationCallOrder[0]!);
  expect(readInstallationState(home)!.targets).toEqual([]);
  expect(existsSync(join(pi, 'settings.json'))).toBe(false);
  expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe('{invalid');
  expect(readFileSync(join(home, '.env'), 'utf8')).toBe('SECRET=preserve\n');
  expect(readFileSync(join(data, 'memory.md'), 'utf8')).toBe('keep');
});

it('does not mutate registrations when the asynchronous lifecycle hook declines removal', async () => {
  const pi = join(root, 'pi'); installIntegrations([{ id: 'pi', name: 'Pi', root: pi, mode: 'posix', hooks: true }], data, { home });
  writeFileSync(join(home, 'config.json'), '{invalid'); const state = readInstallationState(home), removePackage = vi.fn(async () => {});
  await expect(uninstallWithUnreadableConfig({ beforeRemove: async () => { throw new Error('SERVICE_STOP_FAILED'); }, installation: installation(), removePackage })).rejects.toThrow('SERVICE_STOP_FAILED');
  expect(removePackage).not.toHaveBeenCalled(); expect(readInstallationState(home)).toEqual(state);
});

it('does not remove the application if a live unowned registration would be orphaned', async () => {
  const pi = join(root, 'pi'); installIntegrations([{ id: 'pi', name: 'Pi', root: pi, mode: 'posix', hooks: true }], data, { home });
  writeFileSync(join(home, 'config.json'), '{invalid');
  writeFileSync(join(pi, 'settings.json'), JSON.stringify({ packages: ['npm:common-memory-core'] }));
  const removePackage = vi.fn(async () => {});
  await expect(uninstallWithUnreadableConfig({ installation: installation(), removePackage })).rejects.toThrow('未由此安装器管理');
  expect(removePackage).not.toHaveBeenCalled();
  expect(readInstallationState(home)!.targets).toEqual([{ id: 'pi', name: 'Pi', root: pi, mode: 'posix', hooks: true }]);
});
