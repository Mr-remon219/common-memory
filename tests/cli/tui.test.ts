import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as clack from '@clack/prompts';
import { defaultConfig, envFilePath, loadConfig, saveConfig } from '../../src/config/config.js';
import { runShowTui, runTui } from '../../src/cli/tui.js';
import { modifyMemory } from '../../src/cli/modify-memory.js';
import { registerProject } from '../../src/cli/operations.js';
import { terminalText, UserCancelled, viewText } from '../../src/cli/tui-prompts.js';
import { runAdvancedWizard, runCredentialsWizard, runNetworkWizard, runPermissionsWizard, runSetupWizard, saveSettings } from '../../src/cli/tui-settings.js';

vi.mock('@clack/prompts', () => ({
  select: vi.fn(), multiselect: vi.fn(), text: vi.fn(), password: vi.fn(), confirm: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol', intro: vi.fn(), outro: vi.fn(), note: vi.fn(),
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/cli/modify-memory.js', () => ({ modifyMemory: vi.fn() }));

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
  const done = choices('overview', 'browse', 'back', 'exit');
  await runTui(); done();
  const menus = vi.mocked(clack.select).mock.calls.map(call => call[0]);
  expect(menus[0]!.options.map(option => option.value)).toEqual(['overview', 'browse', 'modify', 'exit']);
  expect(menus.at(-1)!.initialValue).toBe('browse');
  expect(notes()).toContain(config.dataRoot);
  expect(notes()).toContain('按需运行');
  expect(notes()).not.toContain('Running');
  expect(existsSync(config.dataRoot)).toBe(false);
  expect(modifyMemory).not.toHaveBeenCalled();
});

it('reads actual canonical content, escapes terminal commands and never edits the file', async () => {
  const config = fixture();
  mkdirSync(join(config.dataRoot, 'memory'), { recursive: true });
  const path = join(config.dataRoot, 'memory/profile.md'), body = '# Profile\n\n## Test\nSynthetic \x1b]52;c;attack\x07\n';
  writeFileSync(path, body);
  const done = choices('browse', 'profile', 'back', 'back', 'exit');
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
  const done = choices('browse', 'projects', a.id, Symbol('document cancel'), Symbol('project cancel'), 'back', 'exit');
  await runShowTui(); done();
  const menus = vi.mocked(clack.select).mock.calls.map(call => call[0]);
  expect(menus.find(menu => menu.message === 'Memory')!.options.map(o => o.value)).toEqual(['projects', 'back']);
  expect(menus.find(menu => menu.message === 'Projects')!.options.map(o => o.value)).toEqual([a.id, 'back']);
  expect(notes()).toContain('Visible');
});

it('opens Modify directly, sends the unchanged user expression, and does not call a processed request an update', async () => {
  const config = fixture(); texts('I no longer use Cursor Ultra. Update my preferences.');
  vi.mocked(modifyMemory).mockResolvedValue({ requestId: 'tui:test', complete: true, cancelled: false, outcome: { state: 'processed', issue: null, retainedIn: [], jobId: 'j', jobState: 'done', attempts: 1, retryAt: null, diagnostic: null } });
  const done = choices('modify', 'exit');
  await runShowTui(); done();
  expect(modifyMemory).toHaveBeenCalledWith(config, 'I no longer use Cursor Ultra. Update my preferences.');
  expect(clack.confirm).not.toHaveBeenCalled();
  expect(clack.log.success).toHaveBeenCalledWith(expect.stringContaining('也可能没有变化'));
});

it('does not submit a cancelled prompt or a prompt opened before concurrent config changes', async () => {
  const config = fixture();
  const done = choices('modify', 'modify', 'exit');
  vi.mocked(clack.text).mockResolvedValueOnce(Symbol('cancel')).mockImplementationOnce(async () => {
    saveConfig({ ...config, writableScopes: [] }); return 'Change my preferences';
  });
  await runShowTui(); done();
  expect(modifyMemory).not.toHaveBeenCalled();
  expect(clack.log.error).toHaveBeenCalledWith(expect.stringContaining('配置已被其他操作修改'));
});

it.each(['pending', 'dead', 'quarantined'])('never reports %s as a successful modification', async state => {
  fixture(); texts('A synthetic change'); choices('modify', 'exit');
  vi.mocked(modifyMemory).mockResolvedValue({ requestId: 'tui:test', complete: false, cancelled: false, outcome: { state, issue: null, retainedIn: [], jobId: 'j', jobState: state === 'dead' ? 'dead' : null, attempts: 1, retryAt: null, diagnostic: null } });
  await runShowTui();
  expect(clack.log.success).not.toHaveBeenCalled();
  expect(notes()).toContain('未完成');
});

it('keeps errors inside the current action and Esc on home exits', async () => {
  fixture(); texts('Synthetic'); choices('modify', Symbol('home cancel'));
  vi.mocked(modifyMemory).mockRejectedValue(new Error('Synthetic failure\x1b[2J'));
  await runShowTui();
  expect(clack.log.error).toHaveBeenCalledWith('Synthetic failure\\u001b[2J');
  expect(clack.outro).toHaveBeenCalledWith('Done');
});

it('paginates in both directions with all lines reachable', async () => {
  const done = choices('next', 'previous', 'back');
  await viewText('Document', Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')); done();
  expect(vi.mocked(clack.note).mock.calls[0]![0]).toBe(vi.mocked(clack.note).mock.calls[2]![0]);
  expect(terminalText('\u009b2J\u202eevil')).toBe('\\u009b2J\\u202eevil');
});

// Direct configuration forms remain compatible while two-field setup policy is pending.
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
