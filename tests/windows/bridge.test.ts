import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { parse } from 'smol-toml';

// Rendering runs in WSL in production. Only that runtime description is synthetic;
// Windows tests execute the resulting script in real Windows PowerShell 5.1.
const runtime = vi.hoisted(() => ({
  node: "/opt/Node \"quoted\" '中文 $data/node", cli: "/opt/Memory '中文 $data/main.js",
  home: "/home/test/Memory \"quoted\" '中文 $data", distro: "Ubuntu '中文 $data", user: 'tester',
  wslExe: 'C:\\Windows\\System32\\wsl.exe',
}));
vi.mock('../../src/cli/host-launch.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/cli/host-launch.js')>(),
  runtimeLaunch: () => ({ ...runtime, command: (args: string[]) => ({
    command: runtime.wslExe,
    args: ['-d', runtime.distro, '-u', runtime.user, '-e', '/usr/bin/env', `COMMON_MEMORY_HOME=${runtime.home}`, runtime.node, runtime.cli, ...args],
  }) }),
}));
import { renderHostConfig, renderWindowsBridge, writeHostBundle } from '../../src/cli/work-config.js';

const psQuote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const powershell = process.platform === 'win32'
  ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  : '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const native = process.platform === 'win32' || Boolean(process.env.WSL_DISTRO_NAME && existsSync(powershell));
let root: string;
const win = (path: string) => process.platform === 'win32' ? path : execFileSync('/usr/bin/wslpath', ['-w', path], { encoding: 'utf8' }).trim();
const ps = (source: string, input = '', env: NodeJS.ProcessEnv = {}) => spawnSync(powershell,
  ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ProgressPreference='SilentlyContinue';\n" + source, 'utf16le').toString('base64')],
  { input, encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...env } });
beforeAll(() => {
  if (!native) throw new Error('Windows bridge tests require native Windows PowerShell or real WSL interop');
  const temp = process.platform !== 'win32' && native
    ? execFileSync('/usr/bin/wslpath', ['-u', ps('[Console]::Write($env:TEMP)').stdout.trim()], { encoding: 'utf8' }).trim()
    : tmpdir();
  root = mkdtempSync(join(temp, 'cm-native-bridge-'));
  if (native) {
    const compile = ps(`Add-Type -TypeDefinition ${psQuote(readFileSync(resolve('tests/windows/fixtures/recorder.cs'), 'utf8'))} -OutputAssembly ${psQuote(win(join(root, 'wsl recorder.exe')))} -OutputType ConsoleApplication`);
    expect(compile.error).toBeUndefined(); expect(compile.status, compile.stderr).toBe(0);
  }
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

it('generates parseable host config with fixed WSL argv, read/init isolation and encoded literal hook paths', () => {
  const path = "C:\\Memory '中文 $data & (test)\\bridge.ps1";
  for (const client of ['codex', 'chatgpt-work'] as const) {
    const bundle = renderHostConfig(client, { wsl: true }, {}, path);
    const config = parse(bundle.config) as any;
    const read = config.mcp_servers.common_memory;
    expect(read.command).toBe(runtime.wslExe);
    expect(read.args).toEqual(['-d', runtime.distro, '-u', 'tester', '-e', '/usr/bin/env', `COMMON_MEMORY_HOME=${runtime.home}`, runtime.node, runtime.cli,
      'mcp', '--client-id', client === 'codex' ? 'codex-cli' : 'chatgpt-work', '--capability', 'read', '--global']);
    expect(config.mcp_servers.common_memory_init).toMatchObject(client === 'codex' ? { enabled: false } : { default_tools_approval_mode: 'approve' });
    expect(Object.keys(config.hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd']);
    for (const [event, entries] of Object.entries(config.hooks) as [string, any[]][]) {
      const handler = entries[0].hooks[0];
      if (['SessionStart', 'UserPromptSubmit', 'PostToolUse'].includes(event)) expect(handler.additionalContextLimit).toBe(0);
      else expect(handler).not.toHaveProperty('additionalContextLimit');
    }
    const command = config.hooks.SessionStart[0].hooks[0].command as string;
    expect(Buffer.from(command.split(' -EncodedCommand ')[1]!, 'base64').toString('utf16le'))
      .toBe(`& ${psQuote(path)} -Action ${client === 'codex' ? 'codex-hook' : 'work-hook'} -Client ${client}; exit $LASTEXITCODE`);
    expect(bundle.policy).toContain('allow_implicit_invocation: false');
    expect(bundle.config.toLowerCase()).not.toContain('bypass');
  }
  for (const path of [undefined, 'relative.ps1', 'C:\\bad"path.ps1', 'C:\\bad\npath.ps1']) {
    expect(() => renderHostConfig('chatgpt-work', { wsl: true }, {}, path)).toThrow('--bridge-path');
  }
});

it('writes a UTF-8 BOM for PowerShell 5.1 and refuses to overwrite an installed bundle', () => {
  const bundle = renderHostConfig('chatgpt-work', { wsl: true }, {}, 'C:\\bridge.ps1');
  const output = join(root, 'bundle'); writeHostBundle(output, bundle);
  expect(readFileSync(join(output, 'common-memory-bridge.ps1')).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  expect(readFileSync(join(output, 'common-memory.config.toml'), 'utf8')).toBe(bundle.config);
  expect(() => writeHostBundle(output, bundle)).toThrow('already exists');
});

function launch(action: string, event: object, options: { missingHost?: boolean; conversionFail?: boolean; exit?: number } = {}) {
  const record = join(root, 'record.txt'); rmSync(record, { force: true });
  runtime.wslExe = win(join(root, 'wsl recorder.exe'));
  const bridge = join(root, "bridge '中文 $data.ps1");
  writeFileSync(bridge, '\ufeff' + renderWindowsBridge({ wsl: true }));
  // Synthetic host metadata only; native argv marshaling, stdin and exit are real.
  const source = `$ErrorActionPreference='Stop'
function global:Get-CimInstance { param($ClassName,$Filter)
  if ($Filter -eq "ProcessId=$PID") { return @{ParentProcessId=123} }
  return @{Name=${psQuote(options.missingHost ? 'unconfirmed.exe' : 'codex-synthetic.exe')};ProcessId=123;ParentProcessId=0;CreationDate=[datetime]'2026-01-01Z'}
}
$env:CM_BRIDGE_RECORD=${psQuote(win(record))}
$env:CM_BRIDGE_EXIT='${options.exit ?? 0}'
$env:CM_BRIDGE_CONVERSION_FAIL='${options.conversionFail ? 1 : 0}'
$env:CODEX_THREAD_ID='thread 中文'
& ${psQuote(win(bridge))} -Action ${action} -Client chatgpt-work
exit $LASTEXITCODE`;
  const result = ps(source, JSON.stringify(event));
  const calls = existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').map(line => {
    const [argv, stdin] = line.trim().split('\t');
    return { args: Buffer.from(argv!, 'base64').toString('utf8').split('\0'), stdin: Buffer.from(stdin ?? '', 'base64').toString('utf8') };
  }) : [];
  expect(result.error).toBeUndefined();
  return { result, calls };
}

it('executes PowerShell through a native executable: argv, Unicode stdin, path conversion and exit status survive', () => {
  const event = { cwd: "C:\\Project '中文 $data & (x)\\", transcript_path: "C:\\Project '中文 $data\\转录.jsonl", prompt: 'Hello "中文" $HOME\nnext line' };
  const { result, calls } = launch('work-hook', event, { exit: 23 });
  expect(result.status, result.stderr).toBe(23);
  expect(calls).toHaveLength(3);
  expect(calls[0]!.args).toEqual(['-d', runtime.distro, '-u', 'tester', '-e', '/usr/bin/wslpath', '-u', event.cwd]);
  expect(calls[1]!.args.at(-1)).toBe(event.transcript_path);
  expect(calls[2]!.args).toEqual(['-d', runtime.distro, '-u', 'tester', '-e', '/usr/bin/env', `COMMON_MEMORY_HOME=${runtime.home}`,
    expect.stringMatching(/^COMMON_MEMORY_HOST_INSTANCE=windows:123:/), 'CODEX_THREAD_ID=thread 中文', runtime.node, runtime.cli, 'work-hook', '--home', runtime.home]);
  expect(JSON.parse(calls[2]!.stdin)).toEqual({ ...event, cwd: "/mnt/c/Project '中文 $data & (x)/", transcript_path: "/mnt/c/Project '中文 $data/转录.jsonl" });
  expect(result.stdout).toContain('BRIDGE_OK');
});

it('passes POSIX paths unchanged and forwards refresh without reading hook input', () => {
  const event = { cwd: '/tmp/project', transcript_path: '/tmp/转录.jsonl' };
  const hook = launch('codex-hook', event);
  expect(hook.result.status, hook.result.stderr).toBe(0); expect(hook.calls).toHaveLength(1);
  expect(JSON.parse(hook.calls[0]!.stdin)).toEqual(event);
  const refresh = launch('session-refresh', {});
  expect(refresh.result.status, refresh.result.stderr).toBe(0); expect(refresh.calls).toHaveLength(1);
  expect(refresh.calls[0]!.args.slice(-5)).toEqual(['session-refresh', '--home', runtime.home, '--client', 'chatgpt-work']);
});

it('fails closed before forwarding when host identity or path conversion is unconfirmed', () => {
  const event = { cwd: 'C:\\project', transcript_path: 'C:\\turn.jsonl' };
  const host = launch('work-hook', event, { missingHost: true });
  expect(host.result.status).not.toBe(0); expect(host.result.stderr).toContain('CODEX_HOST_PROCESS_UNCONFIRMED'); expect(host.calls).toEqual([]);
  const conversion = launch('work-hook', event, { conversionFail: true });
  expect(conversion.result.status).not.toBe(0); expect(conversion.result.stderr).toContain('WSL_PATH_CONVERSION_FAILED'); expect(conversion.calls).toHaveLength(1);
});
