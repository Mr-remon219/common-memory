import { stubInstalledBuild } from '../helpers/installation-build.js';
import * as clack from '@clack/prompts';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, loadConfig, saveConfig } from '../../src/config/config.js';
import { configureModel } from '../../src/cli/model-configuration.js';
import { discoverModels } from '../../src/cli/model-discovery.js';
import { runSetupFlow } from '../../src/cli/setup.js';
import { runTui } from '../../src/cli/tui.js';
import { scanIntegrationTargets } from '../../src/cli/integration-targets.js';
import { readInstallationState } from '../../src/cli/integrations.js';
import { writeInstallationFile } from '../../src/cli/installation-files.js';
import { UserCancelled } from '../../src/cli/tui-prompts.js';

vi.mock('@clack/prompts', () => ({ select: vi.fn(), multiselect: vi.fn(), text: vi.fn(), password: vi.fn(), confirm: vi.fn(), isCancel: (v: unknown) => typeof v === 'symbol', intro: vi.fn(), outro: vi.fn(), note: vi.fn(), log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/cli/model-discovery.js', () => ({ discoverModels: vi.fn() }));
vi.mock('../../src/cli/integration-targets.js', () => ({ scanIntegrationTargets: vi.fn() }));
let home: string;
const originalIn = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), originalOut = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
beforeEach(() => {
  vi.resetAllMocks(); stubInstalledBuild(); home = mkdtempSync(join(tmpdir(), 'cm-setup-')); vi.stubEnv('COMMON_MEMORY_HOME', home);
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  vi.mocked(discoverModels).mockResolvedValue([{ id: 'model-a', api: 'chat_completions' }, { id: 'model-b', api: 'chat_completions' }]);
  vi.mocked(clack.password).mockResolvedValue('synthetic-private-key'); vi.mocked(scanIntegrationTargets).mockReturnValue([]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const [stream, descriptor] of [[process.stdin, originalIn], [process.stdout, originalOut]] as const) { if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor); else Reflect.deleteProperty(stream, 'isTTY'); }
  rmSync(home, { recursive: true, force: true });
});
function choices(...values: (string | symbol)[]) {
  vi.mocked(clack.select).mockImplementation(async opts => {
    const value = values.shift(); if (value === undefined) throw new Error(`Unexpected menu: ${opts.message}`);
    if (typeof value === 'string') expect(opts.options.map(o => o.value)).toContain(value);
    return value as never;
  });
  return () => expect(values).toEqual([]);
}
const displayed = () => JSON.stringify([...vi.mocked(clack.note).mock.calls, ...vi.mocked(clack.log.info).mock.calls, ...vi.mocked(clack.log.error).mock.calls]);

it('uses Provider → hidden key → discovered single-select model, and Enter saves without more questions', async () => {
  const done = choices('deepseek', 'model-b');
  expect(discoverModels).not.toHaveBeenCalled();
  const config = await configureModel(); done();
  expect(config.remote).toMatchObject({ preset: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'model-b', api: 'chat_completions' });
  expect(clack.text).not.toHaveBeenCalled(); expect(clack.multiselect).not.toHaveBeenCalled(); expect(clack.confirm).not.toHaveBeenCalled();
  expect(readFileSync(join(home, '.env'), 'utf8')).toContain('synthetic-private-key'); expect(displayed()).not.toContain('synthetic-private-key');
  expect(existsSync(config.dataRoot)).toBe(false);
});
it('re-entering model selection refreshes the list, without persisting a cancelled model or key', async () => {
  vi.mocked(discoverModels).mockResolvedValueOnce([{ id: 'old-model', api: 'chat_completions' }]).mockResolvedValueOnce([{ id: 'new-model', api: 'chat_completions' }]);
  const done = choices('deepseek', Symbol('back'), 'new-model');
  await configureModel(); done(); expect(discoverModels).toHaveBeenCalledTimes(2); expect(loadConfig()!.remote.model).toBe('new-model');
});
it('Custom asks only Base URL, Key and Model Name and makes no discovery call', async () => {
  choices('custom'); vi.mocked(clack.text).mockResolvedValueOnce('https://custom.test/v1').mockResolvedValueOnce('my-model');
  const config = await configureModel();
  expect(config.remote).toMatchObject({ preset: 'custom', baseUrl: 'https://custom.test/v1', model: 'my-model', api: 'chat_completions' });
  expect(discoverModels).not.toHaveBeenCalled(); expect(clack.text).toHaveBeenCalledTimes(2); expect(clack.password).toHaveBeenCalledTimes(1);
});
it('Esc moves back through custom fields without saving', async () => {
  choices('custom', Symbol('exit'));
  vi.mocked(clack.text).mockResolvedValueOnce('https://custom.test/v1').mockResolvedValueOnce(Symbol('model back')).mockResolvedValueOnce(Symbol('URL back'));
  vi.mocked(clack.password).mockResolvedValueOnce('secret-not-saved').mockResolvedValueOnce(Symbol('key back'));
  await expect(configureModel()).rejects.toBeInstanceOf(UserCancelled);
  expect(loadConfig()).toBeNull(); expect(existsSync(join(home, '.env'))).toBe(false);
});
it('discovery failure never saves a key and allows choosing another provider', async () => {
  choices('deepseek', Symbol('exit')); vi.mocked(discoverModels).mockRejectedValue(new Error('模型发现失败'));
  await expect(configureModel()).rejects.toBeInstanceOf(UserCancelled);
  expect(loadConfig()).toBeNull(); expect(existsSync(join(home, '.env'))).toBe(false);
});
it('preserves unrelated config and clears incompatible provider tuning on explicit model change', async () => {
  const config = defaultConfig(); config.remote.model = 'previous'; config.remote.reasoningEffort = 'high'; config.remote.maxOutputTokens = 2048; config.writableScopes = []; saveConfig(config);
  choices('qwen', 'model-a'); const next = await configureModel(loadConfig());
  expect(next.writableScopes).toEqual([]); expect(next.scheduler).toEqual(config.scheduler); expect(next.remote.maxOutputTokens).toBe(2048); expect(next.remote.reasoningEffort).toBeUndefined();
});
it('does not save a model or key over a concurrently changed config', async () => {
  const config = defaultConfig(); config.remote.model = 'previous'; saveConfig(config);
  choices('deepseek', 'model-a', Symbol('exit'));
  vi.mocked(discoverModels).mockImplementation(async () => { saveConfig({ ...config, writableScopes: [] }); return [{ id: 'model-a', api: 'chat_completions' }]; });
  await expect(configureModel(config)).rejects.toBeInstanceOf(UserCancelled);
  expect(loadConfig()!.remote.model).toBe('previous'); expect(existsSync(join(home, '.env'))).toBe(false);
});
it('runs the entire flow, uses Space only for integrations, writes real client config, then exits', async () => {
  choices('deepseek', 'model-a');
  vi.mocked(scanIntegrationTargets).mockReturnValue([{ id: 'pi', name: 'Pi', root: join(home, 'pi'), mode: 'posix', hooks: true }]);
  // A regression must fail promptly rather than retrying a resolved prompt forever.
  vi.mocked(clack.multiselect).mockResolvedValueOnce(['pi']).mockRejectedValue(new Error('Unexpected integration prompt retry'));
  await runSetupFlow();
  expect(discoverModels).toHaveBeenCalledTimes(1); expect(clack.multiselect).toHaveBeenCalledTimes(1); expect(clack.confirm).not.toHaveBeenCalled();
  expect(readFileSync(join(home, 'pi/settings.json'), 'utf8')).toContain('common-memory.js');
  expect(readInstallationState()!.setupComplete).toBe(true); expect(existsSync(join(home, '.installation/setup-pending'))).toBe(false);
  expect(clack.outro).toHaveBeenCalledWith('Done'); expect(clack.log.success).toHaveBeenCalledWith('Integrations installed');
});
it('resumes interrupted integration installation without discovering models on startup', async () => {
  const config = defaultConfig(); config.remote.model = 'saved-model'; saveConfig(config);
  writeInstallationFile(join(home, '.installation/setup-pending'), 'pending\n');
  await runTui(); expect(discoverModels).not.toHaveBeenCalled(); expect(clack.password).not.toHaveBeenCalled(); expect(loadConfig()!.remote.model).toBe('saved-model');
  expect(clack.log.success).not.toHaveBeenCalledWith('Integrations installed');
});
it('ordinary configured startup does not discover models or scan for installations', async () => {
  const config = defaultConfig(); config.remote.model = 'saved-model'; saveConfig(config); choices('exit');
  await runTui(); expect(discoverModels).not.toHaveBeenCalled(); expect(scanIntegrationTargets).not.toHaveBeenCalled();
});
