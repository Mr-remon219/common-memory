import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'smol-toml';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { defaultConfig, saveConfig } from 'common-memory-core';
const root = process.cwd(), home = join(root, 'automatic-home');
process.env.COMMON_MEMORY_HOME = home;
const packageRoot = new URL('../', import.meta.resolve('common-memory-core'));
const { installIntegrations, removeIntegrations, readInstallationState, reconcileIntegrations } = await import(new URL('dist/cli/integrations.js', packageRoot));
const config = defaultConfig(); config.remote.model = 'synthetic'; saveConfig(config);
const pi = { id: 'pi', name: 'Pi', root: join(root, 'automatic-pi'), mode: 'posix', hooks: true };
const codex = { id: 'codex', name: 'Codex CLI', root: join(root, 'automatic-codex'), mode: 'posix', hooks: false };
mkdirSync(pi.root); writeFileSync(join(pi.root, 'settings.json'), '{"theme":"preserved"}\n');
installIntegrations([pi, codex], config.dataRoot);
const settings = JSON.parse(readFileSync(join(pi.root, 'settings.json'), 'utf8'));
const extension = await import(pathToFileURL(settings.extensions[0]));
const events = [], tools = [], commands = [];
await extension.default({ on: name => events.push(name), registerTool: tool => tools.push(tool.name), registerCommand: name => commands.push(name) });
assert.ok(events.includes('before_agent_start')); assert.ok(events.includes('message_end')); assert.ok(tools.includes('memory_read')); assert.ok(commands.includes('memory-refresh'));
assert.match(readFileSync(join(codex.root, 'config.toml'), 'utf8'), /memory_read/);
assert.equal(readInstallationState().targets.length, 2);
removeIntegrations(['pi', 'codex']);
assert.deepEqual(JSON.parse(readFileSync(join(pi.root, 'settings.json'), 'utf8')), { theme: 'preserved' });
assert.equal(existsSync(settings.extensions[0]), false); assert.equal(existsSync(join(config.dataRoot, 'runtime.sqlite')), false);
// Exercise the TUI's final-state reconciliation against the actual installed package resources.
const capturingCodex = { ...codex, hooks: true }, chatgpt = { ...codex, id: 'chatgpt', name: 'ChatGPT' };
installIntegrations([pi, capturingCodex], config.dataRoot);
const mcpPath = join(codex.root, 'config.toml'), hooksPath = join(codex.root, 'hooks.json');
const mcpBefore = readFileSync(mcpPath, 'utf8'), wrapperBefore = readFileSync(settings.extensions[0], 'utf8');
assert.equal(existsSync(hooksPath), true);
assert.deepEqual(reconcileIntegrations([pi, chatgpt], config.dataRoot, { expectedState: readInstallationState() }), {
  installed: ['chatgpt'], removed: ['codex'], retained: ['pi'],
});
const reconciled = readInstallationState();
assert.deepEqual(reconciled.targets.map(target => target.id), ['pi', 'chatgpt']);
assert.deepEqual(reconciled.resources.find(resource => resource.kind === 'toml').owners, ['chatgpt']);
assert.equal(readFileSync(mcpPath, 'utf8'), mcpBefore);
assert.equal(readFileSync(settings.extensions[0], 'utf8'), wrapperBefore);
assert.equal(existsSync(hooksPath), false);
assert.equal(existsSync(join(codex.root, 'skills/memory-refresh/SKILL.md')), false);
removeIntegrations(['pi', 'chatgpt']);
assert.deepEqual(JSON.parse(readFileSync(join(pi.root, 'settings.json'), 'utf8')), { theme: 'preserved' });
assert.equal(existsSync(mcpPath), false); assert.equal(existsSync(join(config.dataRoot, 'runtime.sqlite')), false);
const { probeReadIntegration } = await import(new URL('dist/cli/integration-probe.js', packageRoot));
// The packaged TUI uses these exact generated registrations, not a hand-built MCP command.
reconcileIntegrations([{ ...codex, init: true }], config.dataRoot, { authorizeAgentImport: { expectedConfig: config } });
assert.deepEqual(await probeReadIntegration(readInstallationState(), codex), { ok: true, code: 'READ_TOOLS_READY' });
assert.equal(existsSync(join(config.dataRoot, 'runtime.sqlite')), false);
writeFileSync(join(home, '.env'), 'OPENAI_API_KEY=synthetic-install-test\n');
const initConfig = parse(readFileSync(mcpPath, 'utf8')).mcp_servers.common_memory_init;
const client = new Client({ name: 'installed-init-check', version: '1' });
const transport = new StdioClientTransport({ command: initConfig.command, args: initConfig.args, env: initConfig.env, stderr: 'pipe' });
let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
try {
  await client.connect(transport, { timeout: 10_000 });
  assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['memory_init', 'memory_status']);
  const status = await client.callTool({ name: 'memory_status', arguments: {} });
  assert.equal(status.structuredContent.initEnabled, true);
  assert.equal(status.structuredContent.readEnabled, false);
} catch (cause) { throw new Error(`Installed init MCP failed: ${stderr}`, { cause }); }
finally { await client.close(); }
removeIntegrations(['codex']);
assert.equal(existsSync(mcpPath), false);
console.log('Packaged installation, Pi registration, mixed reconciliation, real read/init MCP discovery and ownership-safe removal passed.');
