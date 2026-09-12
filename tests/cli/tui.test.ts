import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as clack from '@clack/prompts';
import { defaultConfig, envFilePath, loadConfig, saveConfig } from '../../src/config/config.js';
import { runShowTui, runTui } from '../../src/cli/tui.js';
import { modifyMemory } from '../../src/cli/modify-memory.js';
import * as modelConfiguration from '../../src/cli/model-configuration.js';
import { integrationsScreen } from '../../src/cli/tui-integrations.js';
import { runNetworkTest } from '../../src/cli/network-test.js';
import { runCompleteUninstall } from '../../src/cli/uninstall-tui.js';
import { runFlush } from '../../src/cli/flush-command.js';
import * as settings from '../../src/cli/tui-settings.js';
import { registerProject } from '../../src/cli/operations.js';
import { terminalText, UserCancelled, viewText } from '../../src/cli/tui-prompts.js';
import { runAdvancedWizard, runCredentialsWizard, runNetworkWizard, runPermissionsWizard, runSetupWizard, saveSettings } from '../../src/cli/tui-settings.js';
import { RuntimeStore } from '../../src/v2/runtime.js';

vi.mock('@clack/prompts', () => ({
  select: vi.fn(), multiselect: vi.fn(), text: vi.fn(), password: vi.fn(), confirm: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol', intro: vi.fn(), outro: vi.fn(), note: vi.fn(),
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/cli/modify-memory.js', () => ({ modifyMemory: vi.fn() }));
vi.mock('../../src/cli/tui-integrations.js', () => ({ integrationsScreen: vi.fn() }));
vi.mock('../../src/cli/network-test.js', () => ({ runNetworkTest: vi.fn() }));
vi.mock('../../src/cli/uninstall-tui.js', () => ({ runCompleteUninstall: vi.fn() }));
vi.mock('../../src/cli/flush-command.js', () => ({ runFlush: vi.fn() }));

let home: string;
const originalIn = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const originalOut = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
beforeEach(() => {
  vi.resetAllMocks();
  home = mkdtempSync(join(tmpdir(), 'cm-tui-'));
  vi.stubEnv('COMMON_MEMORY_HOME', home);
  vi.stubEnv('PATH', '');
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const [stream, descriptor] of [[process.stdin, originalIn], [process.stdout, originalOut]] as const) {
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else Reflect.deleteProperty(stream, 'isTTY');
  }
  rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const config = defaultConfig({ COMMON_MEMORY_HOME: home });
  config.remote.model = 'synthetic'; config.remote.apiKeyEnv = 'CM_TUI_TEST_KEY'; config.remote.proxy = { mode: 'direct' };
  saveConfig(config); return loadConfig()!;
}
function choices(...values: (string | symbol)[]) {
  vi.mocked(clack.select).mockImplementation(async opts => {
    const value = values.shift();
    if (value === undefined) throw new Error(`Unexpected menu ${opts.message}`);
    if (typeof value !== 'symbol') expect(opts.options.map(o => o.value), opts.message).toContain(value);
    return value as never;
  });
  return () => expect(values).toEqual([]);
}
function texts(...values: string[]) { for (const value of values) vi.mocked(clack.text).mockResolvedValueOnce(value); }
const notes = () => vi.mocked(clack.note).mock.calls.map(c => c.join('\n')).join('\n');
function readAllPages(): void {
  const select = vi.mocked(clack.select).getMockImplementation()!;
  vi.mocked(clack.select).mockImplementation(async options => options.message === '阅读'
    ? (options.options.some(option => option.value === 'next') ? 'next' : 'back') as never
    : select(options));
}

it('starts setup directly and cancellation creates neither configuration nor memory', async () => {
  vi.mocked(clack.select).mockResolvedValueOnce(Symbol('cancel'));
  await expect(runTui()).rejects.toBeInstanceOf(UserCancelled);
  expect(clack.select).toHaveBeenCalledTimes(1);
  expect(clack.text).not.toHaveBeenCalled();
  expect(existsSync(join(home, 'config.json'))).toBe(false);
  expect(existsSync(envFilePath())).toBe(false);
});

it('has only three management tasks, remembers focus, and never initializes storage while viewing', async () => {
  const config = fixture();
  const done = choices('configuration', 'current', 'back', 'memory', 'browse', 'back', 'back', 'exit'); readAllPages();
  await runTui(); done();
  const menus = vi.mocked(clack.select).mock.calls.map(call => call[0]);
  expect(menus[0]!.options.map(option => option.label)).toEqual(['Agent Integration', 'Memory Control', 'Model & Configuration', '退出']);
  expect(menus[0]!.options.map(option => option.value)).toEqual(['integrations', 'memory', 'configuration', 'exit']);
  expect(menus.at(-1)!.initialValue).toBe('memory');
  expect(notes()).toContain(config.dataRoot);
  expect(notes()).toContain('按需运行');
  expect(notes()).toContain('API Key:'); expect(notes()).toContain('"maxAttempts"'); expect(notes()).toContain('"allowedProvenance"');
  expect(notes()).not.toContain('Running');
  expect(existsSync(config.dataRoot)).toBe(false);
  expect(modifyMemory).not.toHaveBeenCalled();
});

it('routes integration, model, network, connection test and uninstall from the main workbench and reloads changed configuration', async () => {
  const config = fixture(), changed = { ...config, remote: { ...config.remote, model: 'replacement-model' } };
  const configure = vi.spyOn(modelConfiguration, 'configureModel').mockImplementation(async () => { saveConfig(changed); return loadConfig()!; });
  const network = vi.spyOn(settings, 'runNetworkWizard').mockResolvedValue(changed);
  vi.mocked(runNetworkTest).mockImplementation(async (_current, report) => { report?.('{"internalDiagnostic":"network-details"}'); return 0; });
  vi.mocked(runCompleteUninstall).mockResolvedValue(false);
  const done = choices('integrations', 'configuration', 'model', 'network', 'test', 'uninstall', 'back', 'exit');
  await runTui(); done();
  expect(integrationsScreen).toHaveBeenCalledTimes(1); expect(configure).toHaveBeenCalledWith(config);
  expect(network).toHaveBeenCalledWith(loadConfig()); expect(runNetworkTest).toHaveBeenCalledWith(loadConfig(), expect.any(Function));
  expect(runCompleteUninstall).toHaveBeenCalledTimes(1); expect(clack.log.success).toHaveBeenCalledWith('模型连接测试通过。');
  expect(JSON.stringify(vi.mocked(clack.log.info).mock.calls)).not.toContain('internalDiagnostic');
  expect(existsSync(config.dataRoot)).toBe(false);
});

it('returns from model cancellation to configuration and exits the workbench after complete uninstall', async () => {
  fixture(); vi.spyOn(modelConfiguration, 'configureModel').mockRejectedValue(new UserCancelled());
  vi.mocked(runCompleteUninstall).mockResolvedValue(true);
  const done = choices('configuration', 'model', 'uninstall');
  await runTui(); done();
  expect(vi.mocked(clack.select).mock.calls.at(-1)![0]).toMatchObject({ message: 'Model & Configuration', initialValue: 'model' });
  expect(clack.outro).toHaveBeenCalledWith('Done'); expect(clack.log.error).not.toHaveBeenCalled();
});

it('keeps a failed connection test in configuration without reporting success', async () => {
  fixture(); vi.mocked(runNetworkTest).mockResolvedValue(1);
  const done = choices('configuration', 'test', 'back', 'exit');
  await runTui(); done();
  expect(notes()).toContain('连接测试未通过'); expect(clack.log.success).not.toHaveBeenCalled();
});

it('reads actual canonical content, escapes terminal commands and never edits the file', async () => {
  const config = fixture();
  mkdirSync(join(config.dataRoot, 'memory'), { recursive: true });
  const path = join(config.dataRoot, 'memory/profile.md'), body = '# Profile\n\n## Test\nSynthetic \x1b]52;c;attack\x07\n';
  writeFileSync(path, body);
  const done = choices('memory', 'browse', 'profile', 'back', 'back', 'back', 'exit');
  await runShowTui(); done();
  expect(notes()).toContain('\\u001b]52;c;attack\\u0007');
  expect(notes()).not.toContain('\x1b]52');
  expect(readFileSync(path, 'utf8')).toBe(body);
  expect(existsSync(join(config.dataRoot, 'runtime.sqlite'))).toBe(false);
});

it('shows only authorized projects and returns from document and project cancellation one level at a time', async () => {
  const config = fixture();
  const a = registerProject(config, home, 'A');
  const hiddenRoot = join(home, 'hidden'); mkdirSync(hiddenRoot);
  registerProject(config, hiddenRoot, 'Hidden');
  config.disclosure.allowedScopes = [`project:${a.id}`]; saveConfig(config);
  mkdirSync(join(config.dataRoot, 'memory/projects'), { recursive: true });
  writeFileSync(join(config.dataRoot, 'memory/projects', `${a.id}.md`), '# Project\n\n## A\nVisible\n');
  const done = choices('memory', 'browse', 'projects', a.id, Symbol('document cancel'), Symbol('project cancel'), 'back', 'back', 'exit');
  await runShowTui(); done();
  const menus = vi.mocked(clack.select).mock.calls.map(call => call[0]);
  expect(menus.find(menu => menu.message === 'Memory')!.options.map(o => o.value)).toEqual(['search', 'projects', 'back']);
  expect(menus.find(menu => menu.message === 'Projects')!.options.map(o => o.value)).toEqual([a.id, 'back']);
  expect(notes()).toContain('Visible');
});

it('searches literal keywords case-insensitively across authorized Markdown, with complete documents available and no SQLite access', async () => {
  const config = fixture();
  const project = registerProject(config, home, 'Visible project'), hiddenRoot = join(home, 'hidden'); mkdirSync(hiddenRoot);
  const hidden = registerProject(config, hiddenRoot, 'Hidden project');
  config.disclosure.allowedScopes = [...config.disclosure.allowedScopes, `project:${project.id}`]; saveConfig(config);
  mkdirSync(join(config.dataRoot, 'memory/projects'), { recursive: true });
  const profile = '# Profile\n\n## Languages\nUses C++ [alpha] daily.\nAlso studies compilers.\n';
  writeFileSync(join(config.dataRoot, 'memory/profile.md'), profile);
  writeFileSync(join(config.dataRoot, 'memory/preferences.md'), '# Preferences\n\n## Language\nPrefers c++ [ALPHA].\n');
  writeFileSync(join(config.dataRoot, 'memory/projects', `${project.id}.md`), '# Project\n\n## Language\nBuild with C++ [alpha].\n');
  writeFileSync(join(config.dataRoot, 'memory/projects', `${hidden.id}.md`), '# Project\n\n## Hidden\nC++ [alpha] secret hidden match.\n');
  const runtime = join(config.dataRoot, 'runtime.sqlite'); writeFileSync(runtime, 'A sentinel that is not a SQLite database');
  texts('c++ [alpha]');
  const done = choices('memory', 'browse', 'search', 'profile', `project:${project.id}`, 'back', 'back', 'back', 'exit'); readAllPages();
  await runTui(); done();
  const results = vi.mocked(clack.select).mock.calls.map(call => call[0]).filter(menu => menu.message === 'Search Results');
  expect(results).toHaveLength(3);
  expect(results[0]!.options.map(option => option.value)).toEqual(['profile', 'preferences', `project:${project.id}`, 'back']);
  expect(notes()).toContain('Uses C++ [alpha] daily.'); expect(notes()).toContain('Also studies compilers.'); expect(notes()).toContain('Build with C++ [alpha].');
  expect(notes()).not.toContain('secret hidden match'); expect(readFileSync(join(config.dataRoot, 'memory/profile.md'), 'utf8')).toBe(profile);
  expect(readFileSync(runtime, 'utf8')).toBe('A sentinel that is not a SQLite database'); expect(modifyMemory).not.toHaveBeenCalled();
});

it('returns from an empty search without creating memory or runtime storage', async () => {
  const config = fixture(); texts('missing keyword');
  const done = choices('memory', 'browse', 'search', 'back', 'back', 'exit');
  await runTui(); done();
  expect(notes()).toContain('没有找到包含「missing keyword」的已授权记忆'); expect(existsSync(config.dataRoot)).toBe(false);
});

it('opens Adjust Memory, sends the unchanged user expression, and does not call a processed request an update', async () => {
  const config = fixture(); texts('I no longer use Cursor Ultra. Update my preferences.');
  vi.mocked(modifyMemory).mockResolvedValue({ requestId: 'tui:test', complete: true, cancelled: false, outcome: { state: 'processed', issue: null, retainedIn: [], jobId: 'j', jobState: 'done', attempts: 1, retryAt: null, diagnostic: null } });
  const done = choices('memory', 'modify', 'back', 'exit');
  await runShowTui(); done();
  expect(modifyMemory).toHaveBeenCalledWith(config, 'I no longer use Cursor Ultra. Update my preferences.');
  expect(clack.confirm).not.toHaveBeenCalled();
  expect(clack.log.success).toHaveBeenCalledWith(expect.stringContaining('也可能没有变化'));
});

it('does not submit a cancelled prompt or a prompt opened before concurrent config changes', async () => {
  const config = fixture();
  const done = choices('memory', 'modify', 'modify', 'back', 'exit');
  vi.mocked(clack.text).mockResolvedValueOnce(Symbol('cancel')).mockImplementationOnce(async () => {
    saveConfig({ ...config, writableScopes: [] }); return 'Change my preferences';
  });
  await runShowTui(); done();
  expect(modifyMemory).not.toHaveBeenCalled();
  expect(clack.log.error).toHaveBeenCalledWith(expect.stringContaining('配置已被其他操作修改'));
});

it.each(['pending', 'dead', 'quarantined'])('never reports %s as a successful modification', async state => {
  fixture(); texts('A synthetic change'); choices('memory', 'modify', 'back', 'exit');
  vi.mocked(modifyMemory).mockResolvedValue({ requestId: 'tui:test', complete: false, cancelled: false, outcome: { state, issue: null, retainedIn: [], jobId: 'j', jobState: state === 'dead' ? 'dead' : null, attempts: 1, retryAt: null, diagnostic: null } });
  await runShowTui();
  expect(clack.log.success).not.toHaveBeenCalled();
  expect(notes()).toContain('未完成');
});

it('keeps errors inside the current action and Esc on home exits', async () => {
  fixture(); texts('Synthetic'); choices('memory', 'modify', Symbol('memory cancel'), Symbol('home cancel'));
  vi.mocked(modifyMemory).mockRejectedValue(new Error('Synthetic failure\x1b[2J'));
  await runShowTui();
  expect(clack.log.error).toHaveBeenCalledWith('Synthetic failure\\u001b[2J');
  expect(clack.outro).toHaveBeenCalledWith('Done');
});

it('offers only authorized writable projects and forwards the selected workspace with the natural-language request', async () => {
  const config = fixture(), project = registerProject(config, home, 'Writable project');
  const readonlyRoot = join(home, 'readonly'); mkdirSync(readonlyRoot);
  const readonly = registerProject(config, readonlyRoot, 'Read-only project');
  config.disclosure.allowedScopes = [...config.disclosure.allowedScopes, `project:${project.id}`, `project:${readonly.id}`]; config.writableScopes.push(`project:${project.id}`); saveConfig(config);
  const prompt = '把这个项目的构建偏好改为使用 Clang。'; texts(prompt);
  vi.mocked(modifyMemory).mockResolvedValue({ requestId: 'tui:project', complete: true, cancelled: false, outcome: { state: 'processed', issue: null, retainedIn: [`project:${project.id}`], jobId: 'j', jobState: 'done', attempts: 1, retryAt: null, diagnostic: null } });
  const done = choices('memory', 'modify', project.id, 'back', 'exit');
  await runTui(); done();
  const scope = vi.mocked(clack.select).mock.calls.map(call => call[0]).find(menu => menu.message === '调整哪一类记忆？');
  expect(scope!.options.map(option => option.value)).toEqual(['global', project.id, 'back']);
  expect(modifyMemory).toHaveBeenCalledWith(loadConfig(), prompt, { workspace: project.root });
});

it('shows and retries a persisted failed request without submitting its text again', async () => {
  const config = fixture(), store = new RuntimeStore(config.dataRoot, { maxAttempts: 1 });
  let jobId: string;
  try {
    store.enqueue({ sessionId: 'previous-launch', entryId: 'submitted', text: 'Private correction from an earlier launch', source: 'interactive', scope: 'global', observedAt: new Date().toISOString() });
    const job = store.claim({ force: true })!; jobId = job.id; store.fail(job, new Error('private transport detail'));
  } finally { store.close(); }
  vi.mocked(runFlush).mockImplementation(async current => {
    const retry = new RuntimeStore(current.dataRoot);
    try {
      expect(retry.observationOutcome('previous-launch', 'submitted')!.state).toBe('pending');
      const job = retry.claim({ force: true })!; expect(job.observations).toHaveLength(1); retry.finish(job);
    } finally { retry.close(); }
    return 0;
  });
  const done = choices('memory', 'modify', 'processing', 'refresh', `retry:${jobId}`, 'back', 'back', 'back', 'exit');
  await runTui(); done();
  const status = new RuntimeStore(config.dataRoot);
  try { expect(status.observationOutcome('previous-launch', 'submitted')!.state).toBe('processed'); }
  finally { status.close(); }
  expect(notes()).toContain('任务 1 · 处理失败'); expect(notes()).not.toContain(jobId); expect(notes()).not.toContain('Private correction from an earlier launch'); expect(notes()).not.toContain('private transport detail');
  expect(runFlush).toHaveBeenCalledTimes(1); expect(modifyMemory).not.toHaveBeenCalled(); expect(clack.text).not.toHaveBeenCalled();
  expect(clack.log.success).toHaveBeenCalledWith(expect.stringContaining('也可能没有变化'));
});

it('keeps an incomplete persisted request visible and does not report continuation as success', async () => {
  const config = fixture(), store = new RuntimeStore(config.dataRoot);
  try { store.enqueue({ sessionId: 'previous-launch', entryId: 'submitted', text: 'Previous pending request', source: 'interactive', scope: 'global', observedAt: new Date().toISOString() }); }
  finally { store.close(); }
  vi.mocked(runFlush).mockImplementation(async (_current, report) => { report?.('{"internalDiagnostic":"writer-details"}'); return 1; });
  const done = choices('memory', 'modify', 'processing', 'continue', Symbol('processing cancel'), 'back', 'back', 'exit');
  await runTui(); done();
  expect(runFlush).toHaveBeenCalledWith(config, expect.any(Function)); expect(notes()).toContain('等待处理: 1'); expect(notes()).toContain('仍有未完成请求');
  expect(clack.log.success).not.toHaveBeenCalled(); expect(modifyMemory).not.toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(clack.log.info).mock.calls)).not.toContain('internalDiagnostic');
});

it('paginates in both directions with all lines reachable', async () => {
  const done = choices('next', 'previous', 'back');
  await viewText('Document', Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')); done();
  expect(vi.mocked(clack.note).mock.calls[0]![0]).toBe(vi.mocked(clack.note).mock.calls[2]![0]);
  expect(terminalText('\u009b2J\u202eevil')).toBe('\\u009b2J\\u202eevil');
});

// Existing direct configuration forms remain compatible with the unified workbench.
it('preserves configuration, secrets and tuning when changing only a model', async () => {
  const config = fixture(); delete config.remote.proxy;
  config.remote.reasoningEffort = 'low'; config.remote.maxOutputTokens = 1234;
  config.sessionCache = { maxSessionBytes: 2048, contextTailTurns: 0 };
  config.disclosure.allowedProvenance = ['document_import']; saveConfig(config);
  writeFileSync(envFilePath(), 'CM_TUI_TEST_KEY="private-synthetic-key"\n');
  texts('https://example.test/v1', 'new-model'); choices('responses');
  vi.mocked(clack.confirm).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  expect(await runSetupWizard(loadConfig())).toEqual({ ...config, remote: { ...config.remote, baseUrl: 'https://example.test/v1', model: 'new-model' } });
  expect(readFileSync(envFilePath(), 'utf8')).toBe('CM_TUI_TEST_KEY="private-synthetic-key"\n');
  expect(notes()).not.toContain('private-synthetic-key');
});
it('clears incompatible thinking when changing API but preserves output limits', async () => {
  const config = fixture(); config.remote.reasoningEffort = 'high'; config.remote.maxOutputTokens = 2048; saveConfig(config);
  texts(config.remote.baseUrl, config.remote.model); choices('chat_completions');
  vi.mocked(clack.confirm).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const next = await runSetupWizard(loadConfig());
  expect(next.remote.api).toBe('chat_completions'); expect(next.remote.reasoningEffort).toBeUndefined(); expect(next.remote.maxOutputTokens).toBe(2048);
});
it('rejecting model save writes neither configuration nor entered key', async () => {
  const config = fixture(); texts('https://example.test/v1', 'new-model'); choices('responses');
  vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  vi.mocked(clack.password).mockResolvedValue('synthetic-new-key');
  await expect(runSetupWizard(config)).rejects.toBeInstanceOf(UserCancelled);
  expect(loadConfig()).toEqual(config); expect(existsSync(envFilePath())).toBe(false);
});
it('grants provenance independently of writable scopes', async () => {
  const config = fixture(); const project = registerProject(config, home, 'Synthetic');
  vi.mocked(clack.multiselect).mockResolvedValueOnce(['global', `project:${project.id}`]).mockResolvedValueOnce([]).mockResolvedValueOnce(['document_import']);
  vi.mocked(clack.confirm).mockResolvedValue(true);
  await runPermissionsWizard(config);
  expect(loadConfig()!.writableScopes).toEqual([]); expect(loadConfig()!.disclosure.allowedProvenance).toEqual(['document_import']);
  expect(loadConfig()!.sessionCache).toEqual(config.sessionCache);
});
it('updates only a confirmed key without displaying it', async () => {
  const config = fixture(); choices('set'); vi.mocked(clack.password).mockResolvedValue('synthetic-secret'); vi.mocked(clack.confirm).mockResolvedValue(true);
  await runCredentialsWizard(config);
  expect(loadConfig()).toEqual(config); expect(readFileSync(envFilePath(), 'utf8')).toContain('synthetic-secret'); expect(notes()).not.toContain('synthetic-secret');
  choices('set'); vi.mocked(clack.password).mockResolvedValue('replacement'); vi.mocked(clack.confirm).mockResolvedValue(Symbol('cancel'));
  await expect(runCredentialsWizard(config)).rejects.toBeInstanceOf(UserCancelled);
  expect(readFileSync(envFilePath(), 'utf8')).not.toContain('replacement');
});
it('changes credential variables without altering stored secrets', async () => {
  const config = fixture(); writeFileSync(envFilePath(), 'CM_TUI_TEST_KEY="old-secret"\n'); choices('env'); texts('EXTERNAL_MODEL_KEY'); vi.mocked(clack.confirm).mockResolvedValue(true);
  await runCredentialsWizard(config);
  expect(loadConfig()!.remote.apiKeyEnv).toBe('EXTERNAL_MODEL_KEY'); expect(readFileSync(envFilePath(), 'utf8')).toBe('CM_TUI_TEST_KEY="old-secret"\n');
});
it.each([['scheduler', 'maxAttempts', '7'], ['sessionCache', 'contextTailTurns', '0'], ['disclosure', 'maxTotalBytes', '4096']] as const)('preserves sibling settings when changing %s', async (group, field, value) => {
  const config = fixture(); choices('limits', group, field); texts(value); vi.mocked(clack.confirm).mockResolvedValue(true);
  await runAdvancedWizard(config); expect(loadConfig()).toEqual({ ...config, [group]: { ...config[group], [field]: Number(value) } });
});
it('validates output limits and supports reverting optional tuning', async () => {
  const config = fixture(); choices('tuning', 'tokens');
  vi.mocked(clack.text).mockImplementationOnce(async opts => {
    if (typeof opts.validate !== 'function') throw new Error('Expected numeric validator');
    expect(opts.validate?.('0')).toBeTruthy(); expect(opts.validate?.('1.5')).toBeTruthy(); expect(opts.validate?.('16385')).toBeTruthy(); expect(opts.validate?.('')).toBeUndefined(); return '2048';
  });
  vi.mocked(clack.confirm).mockResolvedValue(true); await runAdvancedWizard(config);
  expect(loadConfig()!.remote.maxOutputTokens).toBe(2048);
  choices('tuning', 'tokens'); texts(''); await runAdvancedWizard(loadConfig()!); expect(loadConfig()).toEqual(config);
});
it('does not move or delete data when changing storage', async () => {
  const config = fixture(); mkdirSync(join(config.dataRoot, 'memory'), { recursive: true });
  const path = join(config.dataRoot, 'memory/profile.md'); writeFileSync(path, '# Keep\n');
  const target = join(home, 'other-store'); choices('storage'); texts(target); vi.mocked(clack.confirm).mockResolvedValue(true);
  await runAdvancedWizard(config); expect(loadConfig()!.dataRoot).toBe(target); expect(readFileSync(path, 'utf8')).toBe('# Keep\n'); expect(existsSync(target)).toBe(false);
});
it('detects concurrent config changes', () => {
  const config = fixture(); saveConfig({ ...config, writableScopes: [] }); expect(() => saveSettings(config, config)).toThrow('配置已被其他操作修改');
});
it('network cancellation saves no proxy secrets, and CA changes remain explicit', async () => {
  const config = fixture(); choices('custom', 'keep'); texts(''); vi.mocked(clack.password).mockResolvedValue('http://user:private-proxy@proxy.test:8080'); vi.mocked(clack.confirm).mockResolvedValue(false);
  await expect(runNetworkWizard(config)).rejects.toBeInstanceOf(UserCancelled); expect(loadConfig()).toEqual(config); expect(existsSync(envFilePath())).toBe(false); expect(notes()).not.toContain('private-proxy');
  config.remote.caFileEnv = 'CUSTOM_CA'; saveConfig(config); choices('env', 'keep'); vi.mocked(clack.confirm).mockResolvedValue(true);
  await runNetworkWizard(loadConfig()); expect(loadConfig()!.remote.caFileEnv).toBe('CUSTOM_CA');
  choices('direct', 'remove'); await runNetworkWizard(loadConfig()); expect(loadConfig()!.remote.caFileEnv).toBeUndefined();
});
it.each([undefined,'direct','env','custom'] as const)('network wizard recommends normal system routing and preserves explicit initial %s',mode=>{
 const config=fixture();if(mode===undefined)delete config.remote.proxy;else config.remote.proxy=mode==='custom'?{mode,urlEnv:'SYNTHETIC_PROXY'}:{mode};saveConfig(config);
 vi.mocked(clack.select).mockImplementationOnce(async options=>{
  expect(options.initialValue).toBe(mode??'direct');expect(options.options.map(o=>o.value)).toEqual(['direct','env','custom']);
  expect(options.options[0]!.label).toContain('系统');expect(options.options[0]!.hint).toContain('VPN/TUN');return Symbol('cancel') as never;
 });
 return expect(runNetworkWizard(config)).rejects.toBeInstanceOf(UserCancelled);
});
