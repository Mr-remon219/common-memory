import { realpathSync } from 'node:fs';
import { expect, it } from 'vitest';
import { runtimeLaunch, shellQuote } from '../../src/cli/host-launch.js';

it('pins native launch and escapes POSIX literals without a login shell', () => {
  const launch = runtimeLaunch({ wsl: false }, { COMMON_MEMORY_HOME: '/tmp/memory home' });
  expect(launch.command(['mcp', '--capability', 'read'])).toEqual({
    command: realpathSync(process.execPath), args: [realpathSync(process.argv[1]!), 'mcp', '--capability', 'read'],
    env: { COMMON_MEMORY_HOME: '/tmp/memory home' },
  });
  expect(shellQuote("a ' $data")).toBe("'a '\"'\"' $data'");
});

it('requires a Linux owner and fixed distro, and carries each WSL launch value as a separate argument', () => {
  if (process.platform !== 'linux') {
    expect(() => runtimeLaunch({ wsl: true, distro: 'Ubuntu' }, {})).toThrow('requires a Linux runtime');
    return;
  }
  expect(() => runtimeLaunch({ wsl: true }, {})).toThrow('fixed --distro');
  expect(() => runtimeLaunch({ wsl: true, distro: 'Ubuntu', wslExe: 'wsl.exe' }, {})).toThrow('absolute Windows path');
  const launch = runtimeLaunch({ wsl: true, distro: "Ubuntu '中文", user: 'tester' }, { COMMON_MEMORY_HOME: '/tmp/memory $data' });
  expect(launch.command(['mcp', '--workspace', '/tmp/project space'])).toEqual({
    command: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', "Ubuntu '中文", '-u', 'tester', '-e', '/usr/bin/env', 'COMMON_MEMORY_HOME=/tmp/memory $data',
      realpathSync(process.execPath), realpathSync(process.argv[1]!), 'mcp', '--workspace', '/tmp/project space'],
  });
});
