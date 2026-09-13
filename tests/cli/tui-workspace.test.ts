import { stubInstalledBuild } from '../helpers/installation-build.js';
import * as clack from '@clack/prompts';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, loadConfig, saveConfig } from '../../src/config/config.js';
import { installIntegrations, readInstallationState } from '../../src/cli/integrations.js';
import { registerProject } from '../../src/cli/operations.js';
import { runWorkspaceWizard } from '../../src/cli/tui-workspace.js';
import { UserCancelled } from '../../src/cli/tui-prompts.js';

vi.mock('@clack/prompts', () => ({ select: vi.fn(), confirm: vi.fn(), isCancel: (v: unknown) => typeof v === 'symbol', note: vi.fn(), log: { info: vi.fn() } }));
let home: string;
beforeEach(() => { vi.resetAllMocks(); home = realpathSync(mkdtempSync(join(tmpdir(), 'cm-workspace-'))); vi.stubEnv('COMMON_MEMORY_HOME', home); stubInstalledBuild(); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const config = defaultConfig(); config.remote.model = 'synthetic'; saveConfig(config);
  const a = join(home, 'A'), b = join(home, 'B'); mkdirSync(a); mkdirSync(b);
  const project = registerProject(config, a, 'A'); registerProject(config, b, 'B');
  const root = join(home, 'codex'), other = join(home, 'other');
  installIntegrations([
    { id: 'codex', name: 'Codex', root, mode: 'posix', hooks: false },
    { id: 'chatgpt', name: 'Work', root, mode: 'posix', hooks: false },
    { id: 'pi', name: 'Pi', root: other, mode: 'posix', hooks: true },
  ], config.dataRoot);
  vi.mocked(clack.select).mockResolvedValueOnce(root).mockResolvedValueOnce(a);
  return { config, root, other, a, project };
}
it('explicitly confirms all shared owners, shows actual permission/restart semantics and changes no unrelated root or permissions', async () => {
  const { config, root, other, a } = fixture();
  const pi = readFileSync(join(other, 'settings.json'), 'utf8'); vi.mocked(clack.confirm).mockResolvedValue(true);
  await runWorkspaceWizard();
  const state = readInstallationState()!;
  expect(state.targets.filter(t => t.root === root).map(t => t.readWorkspace)).toEqual([a, a]);
  expect(state.resources.find(r => r.kind === 'toml')!.owners).toEqual(['codex', 'chatgpt']);
  expect(readFileSync(join(other, 'settings.json'), 'utf8')).toBe(pi); expect(loadConfig()).toEqual(config);
  const notes = JSON.stringify(vi.mocked(clack.note).mock.calls);
  expect(notes).toContain('Codex / Work'); expect(notes).toContain('实际读取：global'); expect(notes).toContain('必须重启'); expect(notes).toContain('不跟随聊天 cwd');
});
it('declining a binding leaves client files and all owners exactly unchanged', async () => {
  const { root } = fixture(); const state = readInstallationState(), before = readFileSync(join(root, 'config.toml'), 'utf8');
  vi.mocked(clack.confirm).mockResolvedValue(false);
  await expect(runWorkspaceWizard()).rejects.toBeInstanceOf(UserCancelled);
  expect(readFileSync(join(root, 'config.toml'), 'utf8')).toBe(before); expect(readInstallationState()).toEqual(state);
});
