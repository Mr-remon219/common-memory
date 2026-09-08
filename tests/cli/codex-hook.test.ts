import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { defaultConfig } from '../../src/config/config.js';
import { codexHook, MAX_CONTEXT_BYTES, MAX_HOOK_INPUT_BYTES } from '../../src/cli/codex-hook.js';
import { ProjectRegistry } from '../../src/v2/registry.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "cm-hook ' $ ` "));
  roots.push(home);
  const config = defaultConfig({ COMMON_MEMORY_HOME: home });
  config.remote.model = 'fake';
  const save = () => writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  save();
  const input = (cwd = home, event = 'UserPromptSubmit') => JSON.stringify({ hook_event_name: event, cwd, prompt: 'PRIVATE_PROMPT', source: 'compact', transcript_path: '/must/not/read', session_id: 'ignored' });
  const read = (cwd = home, event = 'UserPromptSubmit') => codexHook(input(cwd, event), home);
  const put = (file: string, body: string) => { mkdirSync(join(config.dataRoot, 'memory/projects'), { recursive: true }); writeFileSync(join(config.dataRoot, 'memory', file), body); };
  return { home, config, save, input, read, put };
}
const context = (result: ReturnType<typeof codexHook>) => result.hookSpecificOutput.additionalContext;
const loader = pathToFileURL(resolve('tests/mcp/fixtures/source-loader.mjs')).href;
function cli(args: string[], input = '', env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, ['--import', loader, resolve('src/cli/main.ts'), ...args], { input, env, encoding: 'utf8', timeout: 10000 });
}

it('empty and missing configuration reads create no data, registry, database or session files', () => {
  const f = fixture();
  expect(context(f.read())).toContain('no stored content');
  expect(context(f.read())).not.toContain('PRIVATE_PROMPT');
  expect(new ProjectRegistry(f.config.dataRoot).list()).toEqual([]);
  expect(existsSync(f.config.dataRoot)).toBe(false);
  rmSync(join(f.home, 'config.json'));
  expect(f.read().systemMessage).toContain('read failed');
  expect(readdirSync(f.home)).toEqual([]);
});

it('reloads canonical updates, deletion, configuration and registry for both events with scope isolation', () => {
  const f = fixture();
  const a = join(f.home, 'a'); const b = join(f.home, 'b');
  mkdirSync(a); mkdirSync(b);
  const registry = new ProjectRegistry(f.config.dataRoot);
  const pa = registry.register(a, 'A'); const pb = registry.register(b, 'B');
  f.config.disclosure.allowedScopes = ['global', `project:${pa.id}`, `project:${pb.id}`]; f.save();
  f.put('profile.md', '# Profile\n## Facts\nGLOBAL-A\n');
  f.put(`projects/${pa.id}.md`, '# Project\n## Facts\nPROJECT-A\n');
  f.put(`projects/${pb.id}.md`, '# Project\n## Facts\nPROJECT-B\n');
  expect(context(f.read(a))).toContain('GLOBAL-A');
  expect(context(f.read(a))).toContain('PROJECT-A');
  expect(context(f.read(a))).not.toContain('PROJECT-B');
  expect(context(f.read(b))).toContain('PROJECT-B');
  expect(context(f.read(b))).not.toContain('PROJECT-A');
  f.put('profile.md', '# Profile\n## Facts\nImported agent summary, uncertain as of 2025: GLOBAL-B\n');
  const latest = context(f.read(a, 'SessionStart'));
  expect(latest).toContain('uncertain as of 2025: GLOBAL-B');
  expect(latest).not.toContain('GLOBAL-A');
  rmSync(join(f.config.dataRoot, 'memory/profile.md'));
  expect(context(f.read(a))).not.toContain('GLOBAL-B');
  f.config.disclosure.allowedScopes = [`project:${pb.id}`]; f.save();
  expect(context(f.read(a))).toContain('no stored content');
  registry.remove(pb.id);
  expect(context(f.read(b))).not.toContain('PROJECT-B');
  expect(existsSync(join(f.config.dataRoot, 'runtime.sqlite'))).toBe(false);
  expect(readdirSync(join(f.config.dataRoot, 'runtime'))).toEqual(['projects.json']);
});

it('rejects malformed protocol without echoing input, but degrades read failures with controlled warnings', () => {
  const f = fixture();
  for (const input of ['', 'null', '[]', '{PRIVATE', '{}',
    JSON.stringify({ hook_event_name: 'Stop', cwd: f.home }),
    JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: 'relative', prompt: '' }),
    JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: f.home }),
    JSON.stringify({ hook_event_name: 'SessionStart', cwd: f.home, source: 'resume' }),
    ' '.repeat(MAX_HOOK_INPUT_BYTES + 1)]) {
    expect(() => codexHook(input, f.home)).toThrow('INVALID_CODEX_HOOK_INPUT');
  }
  writeFileSync(join(f.home, 'config.json'), 'SECRET invalid');
  const failed = f.read();
  expect(failed.systemMessage).toContain('read failed');
  expect(JSON.stringify(failed)).not.toContain('SECRET');
  expect(context(failed)).toContain('do not fall back');
});

it('never truncates oversize Unicode context and includes rules inside the 64 KiB cap', () => {
  const f = fixture();
  f.put('profile.md', '# Profile\n## Facts\n' + '汉'.repeat(23000));
  const over = f.read();
  expect(over.systemMessage).toContain('64 KiB');
  expect(context(over)).not.toContain('汉');
  f.put('profile.md', '# Profile\n## Facts\nx');
  const overhead = Buffer.byteLength(context(f.read())) - 1;
  f.put('profile.md', '# Profile\n## Facts\n' + 'x'.repeat(MAX_CONTEXT_BYTES - overhead));
  expect(Buffer.byteLength(context(f.read()))).toBe(MAX_CONTEXT_BYTES);
  expect(f.read().systemMessage).toBeUndefined();
  f.put('profile.md', '# Profile\n## Facts\n' + 'x'.repeat(MAX_CONTEXT_BYTES - overhead + 1));
  expect(f.read().systemMessage).toContain('64 KiB');
});

it.skipIf(process.platform === 'win32')('unsafe canonical and registry ancestors fail without disclosing linked data', () => {
  const f = fixture();
  const outside = join(f.home, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, 'profile.md'), '# Profile\n## Secret\nDO_NOT_DISCLOSE\n');
  mkdirSync(f.config.dataRoot); symlinkSync(outside, join(f.config.dataRoot, 'memory'));
  expect(f.read().systemMessage).toContain('read failed');
  expect(context(f.read())).not.toContain('DO_NOT_DISCLOSE');
  rmSync(join(f.config.dataRoot, 'memory'));
  symlinkSync(outside, join(f.config.dataRoot, 'runtime'));
  expect(f.read().systemMessage).toContain('read failed');
});

it('CLI bounds stdin, returns JSON, ignores ambient home and reports invalid protocol with nonzero status', () => {
  const f = fixture();
  const env = { ...process.env, COMMON_MEMORY_HOME: join(f.home, 'wrong') };
  const valid = cli(['codex-hook', '--home', f.home], f.input(), env);
  expect(valid.status, valid.stderr).toBe(0);
  expect(context(JSON.parse(valid.stdout))).toContain('no stored content');
  for (const input of ['PRIVATE INVALID', 'x'.repeat(MAX_HOOK_INPUT_BYTES + 1)]) {
    const failed = cli(['codex-hook', '--home', f.home], input);
    expect(failed.status).not.toBe(0); expect(failed.stdout).toBe('');
    expect(failed.stderr).toContain('INVALID_CODEX_HOOK_INPUT');
    expect(failed.stderr).not.toContain('PRIVATE');
  }
  expect(cli(['codex-hook', '--home', 'relative'], f.input()).status).not.toBe(0);
  expect(existsSync(f.config.dataRoot)).toBe(false);
});

it.skipIf(process.platform === 'win32')('generated POSIX commands quote paths, use synchronous official options and never modify configuration', () => {
  const f = fixture();
  const rendered = cli(['codex-config'], '', { ...process.env, COMMON_MEMORY_HOME: f.home });
  expect(rendered.status, rendered.stderr).toBe(0);
  expect(rendered.stdout).toContain('matcher = "^compact$"');
  expect(rendered.stdout).toContain('timeout = 5');
  expect(rendered.stdout).toContain('additionalContextLimit = 0');
  expect(rendered.stdout).not.toContain('bypass_hook_trust');
  const commands = [...rendered.stdout.matchAll(/^command = (.+)$/gm)].map(match => JSON.parse(match[1]!));
  expect(commands).toHaveLength(2);
  // Source loader is a test-only substitution for the built entry; execute the actual shell quoting.
  for (const command of commands) {
    const result = spawnSync('/bin/sh', ['-c', command], {
      input: f.input(), encoding: 'utf8', timeout: 10000,
      env: { ...process.env, NODE_OPTIONS: `--import=${loader}` },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(context(JSON.parse(result.stdout))).toContain('no stored content');
  }
  expect(readdirSync(f.home)).toEqual(['config.json']);
});
