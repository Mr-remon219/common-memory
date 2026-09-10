import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as clack from '@clack/prompts';
import { defaultConfig, envFilePath, loadConfig, saveConfig } from '../../src/config/config.js';
import { runTui } from '../../src/cli/tui.js';
import { runAdvancedWizard, runCredentialsWizard, runNetworkWizard, runPermissionsWizard, runSetupWizard, saveSettings } from '../../src/cli/tui-settings.js';
import { terminalText, UserCancelled, viewText } from '../../src/cli/tui-prompts.js';
import { listProjects, registerProject, runtimeStatus } from '../../src/cli/operations.js';
import { runImport } from '../../src/cli/import-command.js';
import { runFlush } from '../../src/cli/flush-command.js';
import { runNetworkTest } from '../../src/cli/network-test.js';
import { runInteractiveProcess } from '../../src/cli/interactive-process.js';
import { integrationReadiness } from '../../src/cli/tui-integrations.js';

vi.mock('@clack/prompts', () => ({
  select: vi.fn(), multiselect: vi.fn(), text: vi.fn(), password: vi.fn(), confirm: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol', intro: vi.fn(), outro: vi.fn(), note: vi.fn(),
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/cli/import-command.js', () => ({ runImport: vi.fn() }));
vi.mock('../../src/cli/flush-command.js', () => ({ runFlush: vi.fn() }));
vi.mock('../../src/cli/network-test.js', () => ({ runNetworkTest: vi.fn() }));
vi.mock('../../src/cli/interactive-process.js', () => ({ runInteractiveProcess: vi.fn() }));

let home: string;
const originalIn = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const originalOut = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
beforeEach(() => {
  vi.resetAllMocks();
  home = mkdtempSync(join(tmpdir(), 'cm-tui-'));
  vi.stubEnv('COMMON_MEMORY_HOME', home);
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
  config.remote.model = 'synthetic';
  config.remote.apiKeyEnv = 'CM_TUI_TEST_KEY';
  config.remote.proxy = { mode: 'direct' };
  saveConfig(config);
  return loadConfig()!;
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

it('offers first-time setup without forcing it; cancellation returns home and creates nothing', async () => {
  const done = choices('setup', Symbol('cancel'), 'exit');
  texts('https://example.test/v1', 'fake');
  await runTui();
  done();
  expect(existsSync(join(home, 'config.json'))).toBe(false);
  expect(existsSync(envFilePath())).toBe(false);
  expect(clack.outro).toHaveBeenCalled();
});

it('navigates all areas and back, reads the same store without initializing it or making model calls', async () => {
  const config = fixture();
  const done = choices('overview', 'refresh', 'details', 'back', 'back', 'browse', 'back', 'projects', 'back', 'integrations', 'readiness', 'back', 'maintenance', 'back', 'settings', 'back', 'exit');
  await runTui(); done();
  expect(notes()).toContain(config.dataRoot);
  expect(notes()).toContain('还没有处理记录');
  expect(notes()).toContain('不代表助手已安装');
  expect(existsSync(config.dataRoot)).toBe(false);
  expect(runImport).not.toHaveBeenCalled();
  expect(runFlush).not.toHaveBeenCalled();
  expect(runNetworkTest).not.toHaveBeenCalled();
});

it('offers authorization for disabled imports without granting it, and cancels back to home', async () => {
  const config = fixture();
  const done = choices('import', 'browse', Symbol('cancel'), Symbol('cancel'));
  vi.mocked(clack.confirm).mockResolvedValue(false);
  await runTui(); done();
  expect(loadConfig()).toEqual(config);
  expect(clack.multiselect).not.toHaveBeenCalled();
  expect(runImport).not.toHaveBeenCalled();
  expect(clack.outro).toHaveBeenCalled();
});

it('browses only authorized consumer documents and escapes terminal commands without modifying Markdown', async () => {
  const config = fixture();
  mkdirSync(join(config.dataRoot, 'memory'), { recursive: true });
  const content = '# Profile\n\n## Test\nSynthetic \x1b]52;c;attack\x07\n';
  writeFileSync(join(config.dataRoot, 'memory/profile.md'), content);
  const done = choices('browse', 'global', 'profile', 'back', 'back', 'exit');
  await runTui(); done();
  expect(notes()).toContain('\\u001b]52;c;attack\\u0007');
  expect(notes()).not.toContain('\x1b]52');
  expect(readFileSync(join(config.dataRoot, 'memory/profile.md'), 'utf8')).toBe(content);
  expect(existsSync(join(config.dataRoot, 'runtime.sqlite'))).toBe(false);
});

it('paginates long text in both directions with all lines reachable', async () => {
  const done = choices('next', 'previous', 'back');
  await viewText('Document', Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'));
  done();
  expect(clack.note).toHaveBeenCalledTimes(3);
  expect(vi.mocked(clack.note).mock.calls[0]![0]).toBe(vi.mocked(clack.note).mock.calls[2]![0]);
  expect(terminalText('\u009b2J\u202eevil')).toBe('\\u009b2J\\u202eevil');
});

it('registers projects without granting permission and removes only registration after confirmation', async () => {
  const config = fixture();
  const projectRoot = join(home, 'project'); mkdirSync(projectRoot);
  const done = choices('projects', 'register', 'back', 'exit');
  texts(projectRoot, 'Synthetic project');
  vi.mocked(clack.confirm).mockResolvedValue(true);
  await runTui(); done();
  const project = listProjects(config)[0]!;
  expect(project.name).toBe('Synthetic project');
  expect(loadConfig()).toEqual(config);
  mkdirSync(join(config.dataRoot, 'memory/projects'), { recursive: true });
  const path = join(config.dataRoot, 'memory/projects', `${project.id}.md`);
  writeFileSync(path, '# Project\n');
  choices('projects', project.id, 'remove', 'back', 'exit');
  await runTui();
  expect(listProjects(config)).toEqual([]);
  expect(readFileSync(path, 'utf8')).toBe('# Project\n');
  expect(loadConfig()).toEqual(config);
});

it('collects explicit scope/provenance grants independently of writable scopes', async () => {
  const config = fixture();
  const project = registerProject(config, home, 'Synthetic');
  vi.mocked(clack.multiselect).mockResolvedValueOnce(['global', `project:${project.id}`]).mockResolvedValueOnce([]).mockResolvedValueOnce(['document_import']);
  vi.mocked(clack.confirm).mockResolvedValue(true);
  await runPermissionsWizard(config);
  expect(loadConfig()!.writableScopes).toEqual([]);
  expect(loadConfig()!.disclosure.allowedProvenance).toEqual(['document_import']);
  expect(loadConfig()!.disclosure.allowedScopes).toEqual(['global', `project:${project.id}`]);
  expect(loadConfig()!.sessionCache).toEqual(config.sessionCache);
});

it('routes confirmed imports through the existing import command and reports queued rather than remembered', async () => {
  const config = fixture(); config.disclosure.allowedProvenance = ['document_import']; saveConfig(config);
  const done = choices('import', 'global', 'agent', 'queue', 'exit');
  texts(join(home, 'source.md'), 'Visible material');
  vi.mocked(clack.confirm).mockResolvedValue(true);
  vi.mocked(runImport).mockResolvedValue({ exitCode: 0, outcome: null });
  await runTui(); done();
  expect(runImport).toHaveBeenCalledWith(config, [join(home, 'source.md'), '--author', 'agent', '--label', 'Visible material', '--no-wait'], expect.any(Function));
  expect(clack.log.info).toHaveBeenCalledWith(expect.stringContaining('已排队，尚未整理'));
});

it('never imports after rejecting the final confirmation', async () => {
  const config = fixture(); config.disclosure.allowedProvenance = ['document_import']; saveConfig(config);
  choices('import', 'global', 'unknown', 'wait', 'exit');
  texts(join(home, 'source.md'), '');
  vi.mocked(clack.confirm).mockResolvedValue(false);
  await runTui();
  expect(runImport).not.toHaveBeenCalled();
});

it('uses shared flush/probe operations and does not turn failure into success or poison the TUI exit code', async () => {
  fixture();
  choices('maintenance', 'flush', 'back', 'settings', 'probe', 'back', 'exit');
  vi.mocked(clack.confirm).mockResolvedValue(true);
  vi.mocked(runFlush).mockResolvedValue(1);
  vi.mocked(runNetworkTest).mockResolvedValue(1);
  const prior = process.exitCode;
  await runTui();
  expect(runFlush).toHaveBeenCalledTimes(1);
  expect(runNetworkTest).toHaveBeenCalledTimes(1);
  expect(clack.log.warn).toHaveBeenCalledWith(expect.stringContaining('还未完成或已取消'));
  expect(process.exitCode).toBe(prior);
});

it('recovery uses the same machine entry with a pinned home, without broadening session identity', async () => {
  fixture();
  choices('maintenance', 'drain', 'back', 'exit');
  vi.mocked(clack.confirm).mockResolvedValue(true);
  vi.mocked(runInteractiveProcess).mockResolvedValue(1);
  await runTui();
  expect(runInteractiveProcess).toHaveBeenCalledWith(process.execPath, [expect.stringContaining('main.js'), 'session-drain', '--home', home]);
  expect(clack.log.warn).toHaveBeenCalledWith(expect.stringContaining('恢复未完成或已取消'));
});

it('Pi management hands off argument arrays to the official host without shell interpolation', async () => {
  fixture();
  choices('integrations', 'pi', 'list', 'back', 'exit');
  vi.mocked(clack.confirm).mockResolvedValue(true);
  vi.mocked(runInteractiveProcess).mockResolvedValue(0);
  await runTui();
  expect(runInteractiveProcess).toHaveBeenCalledWith('pi', ['list'], expect.objectContaining({ COMMON_MEMORY_HOME: home }));
  expect(notes()).toContain('启停与信任交给 Pi 自己管理');
  expect(integrationReadiness(loadConfig()!)).not.toContain('connected: true');
});

it.skipIf(process.platform === 'win32')('Codex integration previews before export and preserves secrets, capabilities and scope settings', async () => {
  const config = fixture();
  writeFileSync(envFilePath(), 'CM_TUI_TEST_KEY="PRIVATE_EXPORT_SECRET"\n');
  const output = join(home, 'codex-bundle');
  const done = choices('integrations', 'codex', 'posix', 'config', 'back', 'skill', 'back', 'save', 'back', 'exit');
  texts(output);
  vi.mocked(clack.confirm).mockImplementation(async () => {
    expect(existsSync(output)).toBe(false);
    expect(notes()).toContain('连接配置预览');
    expect(notes()).toContain('刷新记忆 Skill 预览');
    return true;
  });
  await runTui(); done();
  expect(clack.log.error).not.toHaveBeenCalled();
  const body = readFileSync(join(output, 'common-memory.config.toml'), 'utf8');
  expect(body).toContain('[mcp_servers.common_memory_init]\nenabled = false');
  expect(body).not.toContain('PRIVATE_EXPORT_SECRET');
  expect(notes()).not.toContain('PRIVATE_EXPORT_SECRET');
  expect(loadConfig()).toEqual(config);
  expect(notes()).toContain('还需在助手中启用');
});

it.skipIf(process.platform === 'win32')('cancelling a Work bundle preview does not create files or change the configuration', async () => {
  const config = fixture(), output = join(home, 'work-bundle');
  const done = choices('integrations', 'work', 'posix', 'config', Symbol('cancel'), 'back', 'exit');
  texts(output);
  await runTui(); done();
  expect(existsSync(output)).toBe(false);
  expect(loadConfig()).toEqual(config);
  expect(clack.confirm).not.toHaveBeenCalled();
});

it.skipIf(process.platform === 'win32')('MCP export uses exclusive creation and reports a collision without leaving the integration area', async () => {
  fixture();
  const output = join(home, 'existing.toml'); writeFileSync(output, 'user configuration');
  const done = choices('integrations', 'mcp', 'posix', 'back', 'back', 'exit');
  texts(output); vi.mocked(clack.confirm).mockResolvedValue(true);
  await runTui(); done();
  expect(readFileSync(output, 'utf8')).toBe('user configuration');
  expect(clack.log.error).toHaveBeenCalledWith(expect.stringContaining('EEXIST'));
});

it('finishes minimal onboarding without asking for an env name or storage path, then offers optional next steps', async () => {
  const done = choices('setup', 'responses', 'back', 'exit');
  texts('https://example.test/v1', 'synthetic');
  vi.mocked(clack.confirm).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await runTui(); done();
  expect(clack.text).toHaveBeenCalledTimes(2);
  expect(loadConfig()!.remote.apiKeyEnv).toBe('OPENAI_API_KEY');
  expect(loadConfig()!.dataRoot).toBe(join(home, 'data'));
  expect(loadConfig()!.disclosure.allowedProvenance).toEqual(['user_explicit']);
  expect(runNetworkTest).not.toHaveBeenCalled();
  expect(existsSync(join(home, 'data'))).toBe(false);
});

it('returns focus to the last home action without opening storage or probing the network', async () => {
  const config = fixture();
  const done = choices('settings', 'back', 'exit');
  await runTui(); done();
  const lastMenu = vi.mocked(clack.select).mock.calls.at(-1)![0];
  expect(lastMenu.initialValue).toBe('settings');
  expect(lastMenu.options.map(o => o.value)).toContain('browse');
  expect(lastMenu.options.map(o => o.value)).toContain('import');
  expect(existsSync(config.dataRoot)).toBe(false);
  expect(runNetworkTest).not.toHaveBeenCalled();
});

it('resumes import after an explicit grant and reloads the saved authorization', async () => {
  const config = fixture();
  const done = choices('import', 'global', 'third_party', 'queue', 'exit');
  vi.mocked(clack.multiselect).mockResolvedValueOnce(['global']).mockResolvedValueOnce(['global']).mockResolvedValueOnce(['user_explicit', 'document_import']);
  vi.mocked(clack.confirm).mockResolvedValue(true);
  texts(join(home, 'notes.md'), '');
  vi.mocked(runImport).mockResolvedValue({ exitCode: 0, outcome: null });
  await runTui(); done();
  expect(runImport).toHaveBeenCalledWith(loadConfig(), [join(home, 'notes.md'), '--author', 'third_party', '--no-wait'], expect.any(Function));
  expect(loadConfig()!.writableScopes).toEqual(config.writableScopes);
});

it('updates only the API key without asking for model details or displaying the secret', async () => {
  const config = fixture();
  const done = choices('set');
  vi.mocked(clack.password).mockResolvedValue('synthetic-secret');
  vi.mocked(clack.confirm).mockResolvedValue(true);
  await runCredentialsWizard(config); done();
  expect(clack.text).not.toHaveBeenCalled();
  expect(loadConfig()).toEqual(config);
  expect(readFileSync(envFilePath(), 'utf8')).toContain('synthetic-secret');
  expect(notes()).not.toContain('synthetic-secret');
  expect(runNetworkTest).not.toHaveBeenCalled();
});

it('does not write a replacement key when its confirmation is cancelled', async () => {
  const config = fixture();
  choices('set');
  vi.mocked(clack.password).mockResolvedValue('synthetic-secret');
  vi.mocked(clack.confirm).mockResolvedValue(Symbol('cancel'));
  await expect(runCredentialsWizard(config)).rejects.toBeInstanceOf(UserCancelled);
  expect(existsSync(envFilePath())).toBe(false);
  expect(loadConfig()).toEqual(config);
});

it('changes the credential environment variable without modifying stored credentials', async () => {
  const config = fixture();
  writeFileSync(envFilePath(), 'CM_TUI_TEST_KEY="old-secret"\n');
  choices('env'); texts('EXTERNAL_MODEL_KEY');
  vi.mocked(clack.confirm).mockResolvedValue(true);
  await runCredentialsWizard(config);
  expect(loadConfig()).toEqual({ ...config, remote: { ...config.remote, apiKeyEnv: 'EXTERNAL_MODEL_KEY' } });
  expect(readFileSync(envFilePath(), 'utf8')).toBe('CM_TUI_TEST_KEY="old-secret"\n');
});

it('edits one numeric tuning value, validates input and preserves every unrelated setting', async () => {
  const config = fixture(); config.remote.reasoningEffort = 'high'; saveConfig(config);
  const done = choices('tuning', 'tokens');
  vi.mocked(clack.text).mockImplementationOnce(async opts => {
    if (typeof opts.validate !== 'function') throw new Error('Expected a numeric validator');
    expect(opts.validate('0')).toBeTruthy();
    expect(opts.validate?.('1.5')).toBeTruthy();
    expect(opts.validate?.('16385')).toBeTruthy();
    expect(opts.validate?.('')).toBeUndefined();
    expect(opts.validate?.('2048')).toBeUndefined();
    return '2048';
  });
  vi.mocked(clack.confirm).mockResolvedValue(true);
  await runAdvancedWizard(config); done();
  expect(loadConfig()).toEqual({ ...config, remote: { ...config.remote, maxOutputTokens: 2048 } });
  choices('tuning', 'tokens'); texts('');
  await runAdvancedWizard(loadConfig()!);
  expect(loadConfig()).toEqual(config);
});

it('offers Responses thinking options and removes the parameter when selecting the API default', async () => {
  const config = fixture(); config.remote.reasoningEffort = 'high'; saveConfig(config);
  choices('tuning', 'thinking', 'default');
  vi.mocked(clack.confirm).mockResolvedValue(true);
  await runAdvancedWizard(config);
  expect(loadConfig()!.remote.reasoningEffort).toBeUndefined();
  expect(clack.text).not.toHaveBeenCalled();
});

it('switches between mutually exclusive Chat thinking formats without modifying output limits', async () => {
  const config = fixture(); config.remote.api = 'chat_completions'; config.remote.thinking = { type: 'enabled' }; config.remote.maxOutputTokens = 2048; saveConfig(config);
  choices('tuning', 'thinking', 'enableThinking:false');
  vi.mocked(clack.confirm).mockResolvedValue(true);
  await runAdvancedWizard(config);
  expect(loadConfig()!.remote.thinking).toBeUndefined();
  expect(loadConfig()!.remote.enableThinking).toBe(false);
  expect(loadConfig()!.remote.maxOutputTokens).toBe(2048);
  choices('tuning', 'thinking', 'thinking:disabled');
  await runAdvancedWizard(loadConfig()!);
  expect(loadConfig()!.remote.enableThinking).toBeUndefined();
  expect(loadConfig()!.remote.thinking).toEqual({ type: 'disabled' });
});

it.each([
  ['scheduler', 'maxAttempts', '7'],
  ['sessionCache', 'contextTailTurns', '0'],
  ['disclosure', 'maxTotalBytes', '4096'],
] as const)('edits a %s field without replacing its siblings', async (group, field, value) => {
  const config = fixture();
  choices('limits', group, field); texts(value);
  vi.mocked(clack.confirm).mockResolvedValue(true);
  await runAdvancedWizard(config);
  expect(loadConfig()).toEqual({ ...config, [group]: { ...config[group], [field]: Number(value) } });
});

it('restores optional cache defaults without writing a second schema or losing unrelated values', async () => {
  const config = fixture(); config.sessionCache = { contextTailTurns: 0 }; saveConfig(config);
  choices('limits', 'sessionCache', 'reset');
  vi.mocked(clack.confirm).mockResolvedValue(true);
  await runAdvancedWizard(config);
  const expected = { ...config }; delete expected.sessionCache;
  expect(loadConfig()).toEqual(expected);
});

it('does not save a numeric edit after rejecting confirmation', async () => {
  const config = fixture();
  choices('limits', 'scheduler', 'maxAttempts'); texts('9');
  vi.mocked(clack.confirm).mockResolvedValue(false);
  await runAdvancedWizard(config);
  expect(loadConfig()).toEqual(config);
});

it('switches stores only after confirmation and never moves or creates memory data', async () => {
  const config = fixture();
  mkdirSync(join(config.dataRoot, 'memory'), { recursive: true });
  const file = join(config.dataRoot, 'memory/profile.md'); writeFileSync(file, '# Keep me\n');
  const target = join(home, 'other-store');
  choices('storage'); texts(target); vi.mocked(clack.confirm).mockResolvedValue(true);
  await runAdvancedWizard(config);
  expect(loadConfig()!.dataRoot).toBe(target);
  expect(readFileSync(file, 'utf8')).toBe('# Keep me\n');
  expect(existsSync(target)).toBe(false);
});

it.skipIf(process.platform === 'win32')('generates a bundle from the review summary without forcing technical pagination', async () => {
  fixture();
  const output = join(home, 'quick-bundle');
  const done = choices('integrations', 'codex', 'posix', 'save', 'back', 'exit');
  texts(output); vi.mocked(clack.confirm).mockResolvedValue(true);
  await runTui(); done();
  expect(existsSync(join(output, 'common-memory.config.toml'))).toBe(true);
  expect(clack.log.error).not.toHaveBeenCalled();
  expect(notes()).toContain('还需在助手中启用');
});

describe('configuration preservation and cancellation', () => {
  function form() { texts('https://example.test/v1', 'new-model'); choices('responses'); }
  it('preserves optional cache, limits, provenance, tuning, private secrets and legacy route absence', async () => {
    const config = fixture();
    delete config.remote.proxy;
    config.remote.reasoningEffort = 'low'; config.remote.maxOutputTokens = 1234;
    config.sessionCache = { maxSessionBytes: 2048, contextTailTurns: 0 };
    config.disclosure.allowedProvenance = ['document_import'];
    saveConfig(config);
    writeFileSync(envFilePath(), 'CM_TUI_TEST_KEY="private-synthetic-key"\n');
    form();
    vi.mocked(clack.confirm).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const next = await runSetupWizard(loadConfig());
    expect(next).toEqual({ ...config, remote: { ...config.remote, baseUrl: 'https://example.test/v1', model: 'new-model' } });
    expect(readFileSync(envFilePath(), 'utf8')).toBe('CM_TUI_TEST_KEY="private-synthetic-key"\n');
    expect(notes()).not.toContain('private-synthetic-key');
    expect(clack.password).not.toHaveBeenCalled();
  });
  it('changing API explicitly clears incompatible thinking while preserving shared tuning', async () => {
    const config = fixture(); config.remote.reasoningEffort = 'high'; config.remote.maxOutputTokens = 2048; saveConfig(config);
    texts(config.remote.baseUrl, config.remote.model); choices('chat_completions');
    vi.mocked(clack.confirm).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const next = await runSetupWizard(loadConfig());
    expect(next.remote.api).toBe('chat_completions');
    expect(next.remote.reasoningEffort).toBeUndefined();
    expect(next.remote.maxOutputTokens).toBe(2048);
  });
  it('rejecting save writes neither configuration nor entered key', async () => {
    const config = fixture(); form();
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    vi.mocked(clack.password).mockResolvedValue('synthetic-new-key');
    await expect(runSetupWizard(config)).rejects.toBeInstanceOf(UserCancelled);
    expect(loadConfig()).toEqual(config);
    expect(existsSync(envFilePath())).toBe(false);
  });
  it('does not replace a concurrently edited configuration', () => {
    const config = fixture(); saveConfig({ ...config, remote: { ...config.remote, model: 'changed-elsewhere' } });
    expect(() => saveSettings(config, config)).toThrow('配置已被其他操作修改');
    expect(loadConfig()!.remote.model).toBe('changed-elsewhere');
  });
  it('network cancellation writes neither proxy secret nor configuration', async () => {
    const config = fixture();
    choices('custom', 'keep'); texts(''); vi.mocked(clack.password).mockResolvedValue('http://user:private-proxy@proxy.test:8080');
    vi.mocked(clack.confirm).mockResolvedValue(false);
    await expect(runNetworkWizard(config)).rejects.toBeInstanceOf(UserCancelled);
    expect(loadConfig()).toEqual(config);
    expect(existsSync(envFilePath())).toBe(false);
    expect(notes()).not.toContain('private-proxy');
  });
  it('keeps existing CA unless explicitly removed, including on route changes', async () => {
    const config = fixture(); config.remote.caFileEnv = 'CUSTOM_CA'; saveConfig(config);
    choices('env', 'keep'); vi.mocked(clack.confirm).mockResolvedValue(true);
    await runNetworkWizard(loadConfig());
    expect(loadConfig()!.remote.caFileEnv).toBe('CUSTOM_CA');
    choices('direct', 'remove');
    await runNetworkWizard(loadConfig());
    expect(loadConfig()!.remote.caFileEnv).toBeUndefined();
    expect(runtimeStatus(loadConfig()!)).toBeNull();
  });
});
