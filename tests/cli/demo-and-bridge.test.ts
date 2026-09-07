import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { defaultConfig } from '../../src/config/config.js';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

it('the synthetic demo refuses a non-empty --home and never touches existing configuration or data', () => {
  const home = mkdtempSync(join(tmpdir(), 'cm-demo-guard-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'config.json'), '{"real":"config"}');
  mkdirSync(join(home, 'data/memory'), { recursive: true });
  writeFileSync(join(home, 'data/memory/profile.md'), '# Profile\n\n## Real\nkeep me\n');
  const result = spawnSync(process.execPath, [resolve('scripts/demo-init-synthetic.mjs'), '--home', home], { encoding: 'utf8', timeout: 30000 });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Refusing to reuse non-empty');
  expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe('{"real":"config"}');
  expect(readFileSync(join(home, 'data/memory/profile.md'), 'utf8')).toContain('keep me');
  expect(readdirSync(home).sort()).toEqual(['config.json', 'data']);
  expect(spawnSync(process.execPath, [resolve('scripts/demo-init-synthetic.mjs'), '--home', join(home, 'config.json')], { encoding: 'utf8', timeout: 30000 }).stderr).toContain('not a directory');
});

// Real Windows -> WSL bridge: only meaningful on a WSL host where wsl.exe is reachable through interop.
const wslExe = '/mnt/c/Windows/System32/wsl.exe';
const bridgeable = process.platform === 'linux' && Boolean(process.env.WSL_DISTRO_NAME) && existsSync(wslExe);
it.skipIf(!bridgeable)('a read-only process launched through wsl.exe reads the same store as a direct launch', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cm-bridge-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const config = defaultConfig({ COMMON_MEMORY_HOME: home });
  config.remote = { provider: 'openai-compatible', model: 'fake', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'CM_TEST_KEY' };
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  mkdirSync(join(config.dataRoot, 'memory'), { recursive: true });
  writeFileSync(join(config.dataRoot, 'memory/profile.md'), '# Profile\n\n## Background\nBridge fixture: keeps a tortoise named Basalt.\n');
  const loader = pathToFileURL(resolve('tests/mcp/fixtures/source-loader.mjs')).href;
  const inner = [process.execPath, '--import', loader, resolve('src/cli/main.ts'), 'mcp', '--client-id', 'codex-cli', '--capability', 'read', '--global'];
  const launches: [string, string[], Record<string, string>][] = [
    ['direct', inner, { ...process.env, COMMON_MEMORY_HOME: home } as Record<string, string>],
    // Exactly the shape `common-memory mcp-config --wsl` prints: fixed distribution, user and absolute paths, no login shell.
    ['wsl.exe', [wslExe, '-d', process.env.WSL_DISTRO_NAME!, '-u', userInfo().username, '-e', '/usr/bin/env', `COMMON_MEMORY_HOME=${home}`, ...inner], process.env as Record<string, string>],
  ];
  const results: Record<string, { text: string; tools: string[] }> = {};
  for (const [name, [command, ...args], env] of launches) {
    const client = new Client({ name: `bridge-${name}`, version: '1' });
    const transport = new StdioClientTransport({ command: command!, args, env, stderr: 'pipe' });
    let stderr = ''; transport.stderr?.on('data', b => { stderr += b; });
    try { await client.connect(transport); } catch (cause) { throw new Error(`${name} failed to connect: ${stderr}`, { cause }); }
    const tools = (await client.listTools()).tools.map(t => t.name);
    const read = await client.callTool({ name: 'memory_read', arguments: {} });
    results[name] = { text: (read.content as { text: string }[])[0]!.text, tools };
    await client.close();
  }
  expect(results.direct!.tools).toEqual(['memory_read', 'memory_status']);
  expect(results['wsl.exe']).toEqual(results.direct);
  expect(results.direct!.text).toContain('tortoise named Basalt');
  expect(existsSync(join(config.dataRoot, 'runtime.sqlite'))).toBe(false);
}, 60000);
