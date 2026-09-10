#!/usr/bin/env node
// Test the actual tarball in a fresh npm installation, never linked to checkout dependencies.
// Run after the full gate/build. npm pack skips lifecycle scripts here to test that exact build.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === '--registry-version' && /^\d+\.\d+\.\d+$/.test(args[1]))) {
  throw new Error('Usage: consumer-smoke.mjs [--registry-version <exact-version>]');
}
const registryVersion = args[1];
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'memory-v2-package-')));
const npmCli = [process.env.npm_execpath, join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'), join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')].find(path => path && existsSync(path));
const run = (args, options = {}) => execFileSync(process.execPath, args, { cwd: temp, encoding: 'utf8', timeout: 180_000, ...options });
const npm = (args, cwd = temp) => {
  assert.ok(npmCli, 'Cannot locate npm CLI; run npm run test:consumer');
  return run([npmCli, ...args], { cwd });
};
let client;
try {
  assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Consumer verification requires Node 24.x');
  if (!registryVersion) assert.ok(existsSync(join(root, 'dist/cli/main.js')), 'Run the full gate/build before testing consumers');
  const [packed] = JSON.parse(npm(['pack', ...(registryVersion ? [`common-memory-core@${registryVersion}`, '--registry=https://registry.npmjs.org/'] : []), '--ignore-scripts', '--json', '--pack-destination', temp], root));
  if (registryVersion) assert.equal(packed.version, registryVersion, 'Registry must serve the requested release');
  const files = new Set(packed.files.map(file => file.path));
  for (const required of ['dist/index.js', 'dist/index.d.ts', 'dist/cli/main.js', 'dist/pi-extension/index.js', 'dist/v2/memory-maintainer.md', 'README.md', 'docs/releasing.md', 'docs/usage.md', 'SECURITY.md', 'CHANGELOG.md', 'LICENSE']) {
    assert.ok(files.has(required), `Missing package file: ${required}`);
  }
  for (const path of files) {
    assert.match(path, /^(?:dist\/|docs\/|package\.json$|README\.md$|SECURITY\.md$|CHANGELOG\.md$|LICENSE$|\.env\.sample$)/, `Unexpected package file: ${path}`);
    assert.ok(!/(?:^|\/)(?:\.env(?!\.sample$)|runtime\.sqlite|node_modules|\.git)(?:[./-]|$)/.test(path), `Private runtime material in package: ${path}`);
    assert.ok(!path.startsWith('dist/recall/') && path !== 'dist/core/contracts/types.js', `Legacy artifact: ${path}`);
  }
  writeFileSync(join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  // No prepare/build hooks or development dependencies may be needed by an npm user.
  console.log(npm(['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', join(temp, packed.filename)]).trim());
  const pkg = join(temp, 'node_modules/common-memory-core');
  assert.equal(realpathSync(pkg), pkg, 'Installed package must not be linked to the checkout');
  assert.ok(readFileSync(join(pkg, 'dist/v2/memory-maintainer.md'), 'utf8').trim(), 'Empty maintainer prompt');
  assert.ok(!existsSync(join(temp, 'node_modules/typescript')), 'Consumer must not inherit build tooling');

  copyFileSync(join(root, 'tests/consumer/consumer.ts.txt'), join(temp, 'consumer.ts'));
  copyFileSync(join(root, 'tests/consumer/installed.mjs'), join(temp, 'installed.mjs'));
  run([join(root, 'node_modules/typescript/bin/tsc'), '--strict', '--skipLibCheck', '--target', 'ES2024', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--noEmit', join(temp, 'consumer.ts')], { stdio: 'inherit' });
  run([join(temp, 'installed.mjs')], { stdio: 'inherit' });

  const cli = join(pkg, 'dist/cli/main.js');
  const home = join(temp, 'read-only-home'); mkdirSync(home);
  const env = { ...process.env, COMMON_MEMORY_HOME: home, CM_CONSUMER_UNUSED_KEY: '' };
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  assert.equal(manifest.license, 'MIT');
  assert.equal(run([cli, '--version'], { env }).trim(), registryVersion ?? manifest.version);
  assert.match(run([cli, '--help'], { env }), /Interactive workbench/);
  assert.match(run([cli], { env }), /no prompts were opened/);
  assert.deepEqual(JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).bin, { 'common-memory': './dist/cli/main.js' });
  const shim = join(temp, 'node_modules/.bin/common-memory');
  if (process.platform !== 'win32') assert.match(execFileSync(shim, ['--help'], { env, encoding: 'utf8', timeout: 15_000 }), /Common Memory/);
  else assert.ok(existsSync(`${shim}.cmd`), 'npm must generate the Windows CLI shim');

  const config = JSON.parse(readFileSync(join(temp, 'synthetic-config.json'), 'utf8'));
  config.dataRoot = join(home, 'data');
  config.remote.apiKeyEnv = 'CM_CONSUMER_UNUSED_KEY';
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  mkdirSync(join(config.dataRoot, 'memory'), { recursive: true });
  writeFileSync(join(config.dataRoot, 'memory/profile.md'), '# Profile\n\n## Package smoke\nSynthetic package reader fact.\n');
  assert.match(run([cli, 'show'], { env }), /Synthetic package reader fact/);
  client = new Client({ name: 'installed-package-consumer', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--client-id', 'package-smoke', '--capability', 'read', '--global'], env, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
  try { await client.connect(transport); }
  catch (cause) { throw new Error(`Installed MCP startup failed:\n${stderr}`, { cause }); }
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['memory_read', 'memory_status']);
  const read = await client.callTool({ name: 'memory_read', arguments: {} });
  assert.notEqual(read.isError, true);
  assert.match(JSON.stringify(read.structuredContent), /Synthetic package reader fact/);
  await client.close(); client = undefined;
  assert.equal(existsSync(join(config.dataRoot, 'runtime.sqlite')), false, 'Read-only installed consumers must not open SQLite');
  console.log(`${registryVersion ? `Published ${registryVersion}` : 'Local'} npm tarball installation passed: typed exports, prompt, durable Writer/readback, Pi load, CLI shim and keyless read-only MCP.`);
} finally {
  try { await client?.close(); } finally { rmSync(temp, { recursive: true, force: true }); }
}
