import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, loadConfig, saveConfig } from '../../src/config/config.js';
import { listProjects, memoryView, registerProject, retryJob, runtimeStatus, showMemory } from '../../src/cli/operations.js';
import { prepareHostBundle, writeHostBundle } from '../../src/cli/work-config.js';
import { RuntimeStore } from '../../src/v2/runtime.js';
import { SessionIngress } from '../../src/v2/session.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cm-workbench-')); vi.stubEnv('COMMON_MEMORY_HOME', home); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const config = defaultConfig({ COMMON_MEMORY_HOME: home });
  config.remote.model = 'synthetic'; config.remote.apiKeyEnv = 'CM_TEST_UNUSED_KEY'; config.remote.proxy = { mode: 'direct' };
  saveConfig(config); return loadConfig()!;
}
function cli(args: string[], input?: string) {
  return spawnSync(process.execPath, ['--import', pathToFileURL(resolve('tests/mcp/fixtures/source-loader.mjs')).href, resolve('src/cli/main.ts'), ...args], { env: { ...process.env, COMMON_MEMORY_HOME: home }, input, encoding: 'utf8', timeout: 15000 });
}

it('no-argument non-TTY and help never open prompts or initialize storage', () => {
  for (const args of [[], ['--help']]) {
    const result = cli(args);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('common-memory');
    expect(result.stdout).not.toContain('What do you want');
  }
  expect(readdirSync(home)).toEqual([]);
});
it('reports the package version without configuration or storage initialization', () => {
  const version = (JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }).version;
  for (const args of [['--version'], ['-v']]) {
    const result = cli(args);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(version);
  }
  expect(readdirSync(home)).toEqual([]);
});
it.each([['config'], ['config', '--network']])('direct wizard %j fails promptly without TTY', (...args) => {
  fixture();
  const result = cli(args);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Interactive terminal required');
  expect(result.stdout).toBe('');
  expect(existsSync(join(home, '.env'))).toBe(false);
});
it('scripted status and show share operations without requiring a key or creating SQLite', () => {
  const config = fixture();
  const status = cli(['status']);
  expect(status.status, status.stderr).toBe(0);
  expect(status.stdout).toContain(config.dataRoot);
  expect(existsSync(config.dataRoot)).toBe(false);
  mkdirSync(join(config.dataRoot, 'memory'), { recursive: true });
  writeFileSync(join(config.dataRoot, 'memory/profile.md'), '# Profile\n\n## Test\nSynthetic memory.\n');
  const expected: string[] = []; showMemory(config, undefined, line => expected.push(line));
  for (const args of [['show'], ['show', '--plain']]) {
    const shown = cli(args);
    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.stdout).toBe(expected.join('\n') + '\n');
  }
  expect(existsSync(join(config.dataRoot, 'runtime.sqlite'))).toBe(false);
});
it.each([['show', '--unexpected'], ['show', '--plain', '--workspace', '/tmp'], ['show', '--workspace']])('rejects unsupported show arguments %j without opening storage', (...args) => {
  const config = fixture();
  const result = cli(args);
  expect(result.status).toBe(1); expect(result.stderr).toContain('unexpected arguments');
  expect(existsSync(config.dataRoot)).toBe(false);
});
it('workspace selection cannot disclose another project or widen global permission', () => {
  const config = fixture();
  const aRoot = join(home, 'a'), bRoot = join(home, 'b'); mkdirSync(aRoot); mkdirSync(bRoot);
  const a = registerProject(config, aRoot, 'A'), b = registerProject(config, bRoot, 'B');
  mkdirSync(join(config.dataRoot, 'memory/projects'), { recursive: true });
  writeFileSync(join(config.dataRoot, 'memory/profile.md'), '# Profile\n\n## Private\nGlobal hidden.\n');
  writeFileSync(join(config.dataRoot, 'memory/projects', `${a.id}.md`), '# Project\n\n## A\nA only.\n');
  writeFileSync(join(config.dataRoot, 'memory/projects', `${b.id}.md`), '# Project\n\n## B\nB hidden.\n');
  config.disclosure.allowedScopes = [`project:${a.id}`, `project:${b.id}`];
  expect(memoryView(config, aRoot).documents.map(d => d.target)).toEqual([`project:${a.id}`]);
  const serialized = JSON.stringify(memoryView(config, aRoot));
  expect(serialized).not.toContain('B hidden'); expect(serialized).not.toContain('Global hidden');
  expect(memoryView(config).documents).toEqual([]);
  expect(existsSync(join(config.dataRoot, 'runtime.sqlite'))).toBe(false);
});
it('status includes jobs and session incompleteness but never raw conversation bodies, retry uses the same queue', () => {
  const config = fixture(); const store = new RuntimeStore(config.dataRoot);
  try {
    const ingress = new SessionIngress(store);
    const key = ingress.open({ client: 'pi', sessionId: 'test', processInstance: 'test-process' });
    ingress.capture(key, { id: 'u1', turnId: 't1', role: 'user', text: 'PRIVATE_SYNTHETIC_BODY', scope: 'global', source: 'interactive', observedAt: new Date().toISOString() });
    ingress.end(key);
    const job = store.claim({ force: true })!;
    store.db.prepare("UPDATE jobs SET state='dead',issue='TEST_FAILURE' WHERE id=?").run(job.id);
    store.db.prepare("UPDATE observations SET state='dead' WHERE jobId=?").run(job.id);
  } finally { store.close(); }
  const status = runtimeStatus(config)!;
  expect(status.sessions[0]).toMatchObject({ closing: true, complete: false, failed: 1 });
  expect(JSON.stringify(status)).not.toContain('PRIVATE_SYNTHETIC_BODY');
  const result = cli(['status']);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('TEST_FAILURE');
  expect(result.stdout).not.toContain('PRIVATE_SYNTHETIC_BODY');
  retryJob(config, status.jobs[0]!.id);
  expect(runtimeStatus(config)!.jobs[0]!.state).toBe('done');
  expect(runtimeStatus(config)!.observations).toContainEqual({ state: 'pending', count: 1 });
});
it('project CLI continues supporting registration, listing, removal without implicit grants', () => {
  const config = fixture();
  const registered = cli(['project', 'register', home, 'CLI project']);
  expect(registered.status, registered.stderr).toBe(0);
  const project = listProjects(config)[0]!;
  const listed = cli(['project', 'list']); expect(JSON.parse(listed.stdout)).toEqual([project]);
  expect(loadConfig()).toEqual(config);
  const removed = cli(['project', 'remove', project.id]);
  expect(removed.stdout).toContain('Markdown retained');
  expect(listProjects(config)).toEqual([]);
});
it.each(['mcp', 'codex-hook', 'work-hook', 'session-refresh'])('%s errors stay machine-oriented without a TUI banner', command => {
  fixture();
  const result = cli([command], '{}');
  expect(result.status).toBe(1); expect(result.stdout).toBe('');
  expect(result.stderr).not.toContain('Interactive terminal');
});
it.skipIf(process.platform === 'win32')('bundle previews have no side effects; writes preserve profile isolation, paths and invocation policy', () => {
  const config = fixture();
  const output = join(home, 'bundle');
  const { bundle } = prepareHostBundle(config, ['--mode', 'posix', '--output', output], 'codex');
  expect(existsSync(output)).toBe(false);
  expect(bundle.config).toContain('[mcp_servers.common_memory_init]\nenabled = false');
  expect(bundle.config).toContain(home);
  writeHostBundle(output, bundle);
  expect(readFileSync(join(output, 'common-memory.config.toml'), 'utf8')).toBe(bundle.config);
  expect(readFileSync(join(output, 'skills/memory-refresh/agents/openai.yaml'), 'utf8')).toContain('allow_implicit_invocation: false');
  expect(() => writeHostBundle(output, { ...bundle, config: 'changed' })).toThrow('already exists');
  expect(readFileSync(join(output, 'common-memory.config.toml'), 'utf8')).toBe(bundle.config);
});
it.skipIf(process.platform === 'win32')('bundle preflight catches late collisions before writing earlier files; existing empty directories still work', () => {
  const config = fixture(), output = join(home, 'bundle');
  const { bundle } = prepareHostBundle(config, ['--mode', 'posix', '--output', output]);
  mkdirSync(join(output, 'skills/memory-refresh/agents'), { recursive: true });
  const policy = join(output, 'skills/memory-refresh/agents/openai.yaml'); writeFileSync(policy, 'existing');
  expect(() => writeHostBundle(output, bundle)).toThrow('already exists');
  expect(existsSync(join(output, 'common-memory.config.toml'))).toBe(false);
  expect(readFileSync(policy, 'utf8')).toBe('existing');
  const empty = join(home, 'empty'); mkdirSync(empty); writeHostBundle(empty, bundle);
  expect(existsSync(join(empty, 'common-memory.config.toml'))).toBe(true);
});
it.skipIf(process.platform === 'win32')('bundle export rejects symlink directories, and bridge text retains UTF-8 BOM', () => {
  const config = fixture(), output = join(home, 'bundle'), other = join(home, 'other');
  mkdirSync(output); mkdirSync(other); symlinkSync(other, join(output, 'skills'), 'dir');
  const { bundle } = prepareHostBundle(config, ['--mode', 'posix', '--output', output]);
  expect(() => writeHostBundle(output, bundle)).toThrow('Unsafe bundle directory');
  expect(readdirSync(other)).toEqual([]);
  const native = join(home, 'native'); writeHostBundle(native, { ...bundle, bridge: 'Synthetic bridge' });
  expect(readFileSync(join(native, 'common-memory-bridge.ps1'), 'utf8')).toBe('\ufeffSynthetic bridge');
});
it.skipIf(process.platform === 'win32')('automation generators still print or export without TTY and pin the actual CLI', () => {
  fixture();
  const printed = cli(['codex-config']);
  expect(printed.status, printed.stderr).toBe(0);
  expect(printed.stdout).toContain(resolve('src/cli/main.ts'));
  expect(printed.stdout).not.toContain('Common Memory / Home');
  const mcp = cli(['mcp-config']);
  expect(mcp.status, mcp.stderr).toBe(0);
  expect(mcp.stdout).toContain('[mcp_servers.common_memory_init]');
  const output = join(home, 'work');
  const generated = cli(['work-config', '--mode', 'posix', '--output', output]);
  expect(generated.status, generated.stderr).toBe(0);
  const body = readFileSync(join(output, 'common-memory.config.toml'), 'utf8');
  expect(body).toContain('chatgpt-desktop'); expect(body).toContain('chatgpt-work');
});
