import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { parse } from 'smol-toml';

export function requireWsl() {
  assert.ok(process.platform === 'linux' && process.env.WSL_DISTRO_NAME && existsSync('/proc/sys/fs/binfmt_misc/WSLInterop'), 'Requires real WSL with Windows interop enabled; Linux/native Windows are not substitutes');
  for (const path of ['/usr/bin/wslpath', '/mnt/c/Windows/System32/wsl.exe', '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe']) assert.ok(existsSync(path), `Missing WSL bridge prerequisite: ${path}`);
}

export async function verifyWsl({ pkg, temp, root }) {
  requireWsl();
  const { defaultConfig } = await import(pathToFileURL(join(pkg, 'dist/config/config.js')));
  const home = join(temp, "WSL memory '中文 $data"); mkdirSync(home);
  const config = defaultConfig({ COMMON_MEMORY_HOME: home }); config.remote.model = 'synthetic';
  writeFileSync(join(home, 'fixture.json'), JSON.stringify(config));
  execFileSync('python3', [join(root, 'tests/wsl/tui.py'), join(temp, 'node_modules/.bin/common-memory'), home], { stdio: 'inherit', timeout: 75_000 });
  mkdirSync(join(config.dataRoot, 'memory'), { recursive: true });
  writeFileSync(join(config.dataRoot, 'memory/profile.md'), '# Profile\n\n## Synthetic\nWSL bridge Unicode 中文');
  const cli = join(pkg, 'dist/cli/main.js');
  const launchArgs = ['mcp', '--client-id', 'codex-cli', '--capability', 'read', '--global'];
  let baseline;
  for (const bridge of [false, true]) {
    const client = new Client({ name: 'wsl-installed-smoke', version: '1' });
    const transport = new StdioClientTransport({
      command: bridge ? '/mnt/c/Windows/System32/wsl.exe' : process.execPath,
      args: bridge ? ['-d', process.env.WSL_DISTRO_NAME, '-u', userInfo().username, '-e', '/usr/bin/env', `COMMON_MEMORY_HOME=${home}`, process.execPath, cli, ...launchArgs] : [cli, ...launchArgs],
      env: { ...process.env, COMMON_MEMORY_HOME: home }, stderr: 'pipe',
    });
    let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
    try {
      await client.connect(transport, { timeout: 15_000 });
      assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['memory_read', 'memory_status']);
      const read = await client.callTool({ name: 'memory_read', arguments: {} });
      assert.notEqual(read.isError, true); assert.match(JSON.stringify(read), /WSL bridge Unicode 中文/);
      if (bridge) assert.deepEqual(read, baseline); else baseline = read;
    } catch (cause) { throw new Error(`WSL MCP bridge=${bridge}: ${stderr}`, { cause }); }
    finally { await client.close(); }
  }
  assert.equal(existsSync(join(config.dataRoot, 'runtime.sqlite')), false);
  console.log('PASS: installed read-only MCP through real wsl.exe matches direct WSL and never opens SQLite.');
  const { reconcileIntegrations, readInstallationState, removeIntegrations } = await import(pathToFileURL(join(pkg, 'dist/cli/integrations.js')));
  const { probeReadIntegration } = await import(pathToFileURL(join(pkg, 'dist/cli/integration-probe.js')));
  const target = { id: 'chatgpt', name: 'Synthetic Desktop', root: join(temp, 'synthetic-desktop-config'), mode: 'windows-wsl', hooks: false, init: true };
  writeFileSync(join(home, '.env'), 'OPENAI_API_KEY=synthetic-wsl-init\n');
  reconcileIntegrations([target], config.dataRoot, { home, authorizeAgentImport: { expectedConfig: config } });
  assert.deepEqual(await probeReadIntegration(readInstallationState(home), target), { ok: true, code: 'READ_TOOLS_READY' });
  assert.equal(existsSync(join(config.dataRoot, 'runtime.sqlite')), false);
  const init = parse(readFileSync(join(target.root, 'config.toml'), 'utf8')).mcp_servers.common_memory_init;
  const initClient = new Client({ name: 'wsl-installed-init-smoke', version: '1' });
  const initTransport = new StdioClientTransport({ command: execFileSync('/usr/bin/wslpath', ['-u', init.command], { encoding: 'utf8' }).trim(), args: init.args, stderr: 'pipe' });
  let initStderr = ''; initTransport.stderr?.on('data', chunk => { initStderr += chunk; });
  try {
    await initClient.connect(initTransport, { timeout: 15_000 });
    assert.deepEqual((await initClient.listTools()).tools.map(t => t.name).sort(), ['memory_init', 'memory_status']);
    assert.equal((await initClient.callTool({ name: 'memory_status', arguments: {} })).structuredContent.initEnabled, true);
  } catch (cause) { throw new Error(`Generated WSL init MCP: ${initStderr}`, { cause }); }
  finally { await initClient.close(); }
  removeIntegrations(['chatgpt'], home);
  assert.equal(existsSync(join(target.root, 'config.toml')), false);
  console.log('PASS: generated opt-in init MCP through real wsl.exe exposes only init/status and is safely removed.');
  // The native synthetic codex ancestor exercises the generated PowerShell hooks,
  // path conversion, refresh, Unicode capture and Writer drain using this installed package.
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts/smoke-work-bridge.mjs'), '--package-root', pkg], { stdio: 'inherit' });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`Native host smoke exited ${code}, signal ${signal}`)); });
  });
}
