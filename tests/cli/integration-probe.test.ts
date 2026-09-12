import { stubInstalledBuild } from '../helpers/installation-build.js';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, stringify } from 'smol-toml';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, saveConfig } from '../../src/config/config.js';
import { installIntegrations, readInstallationState, type InstallationState } from '../../src/cli/integrations.js';
import { probeReadIntegration } from '../../src/cli/integration-probe.js';
import type { IntegrationTarget } from '../../src/cli/integration-targets.js';

let home: string, state: InstallationState, target: IntegrationTarget;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'cm-probe-'))); vi.stubEnv('COMMON_MEMORY_HOME', home); stubInstalledBuild();
  const config = defaultConfig(); config.remote.model = 'synthetic'; saveConfig(config);
  target = { id: 'codex', name: 'Codex', root: join(home, 'codex'), mode: 'posix', hooks: false };
  installIntegrations([target], config.dataRoot); state = readInstallationState()!;
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
function launch(args: string[]) {
  const resource = state.resources[0]!;
  const config = parse(resource.content!), server = (config.mcp_servers as Record<string, any>).common_memory;
  server.args = args;
  resource.content = stringify(config); writeFileSync(resource.path, resource.content);
}
it('performs real source read MCP initialize/tools-list without reading memory or creating SQLite', async () => {
  launch(['--import', pathToFileURL(resolve('tests/mcp/fixtures/source-loader.mjs')).href, resolve('src/cli/main.ts'), 'mcp', '--client-id', 'probe', '--capability', 'read', '--global']);
  expect(await probeReadIntegration(state, target)).toEqual({ ok: true, code: 'READ_TOOLS_READY' });
  expect(existsSync(join(home, 'data/runtime.sqlite'))).toBe(false);
});
it('reports a dead installed CLI instead of mistaking matching config files for a working connection', async () => {
  launch([join(home, 'missing-cli.js')]);
  expect(await probeReadIntegration(state, target)).toEqual({ ok: false, code: 'READ_MCP_FAILED' });
});
it('does not run modified client configuration', async () => {
  const resource = state.resources[0]!; writeFileSync(resource.path, readFileSync(resource.path, 'utf8').replace('memory_read', 'modified'));
  expect(await probeReadIntegration(state, target)).toEqual({ ok: false, code: 'FILES_CHANGED' });
});
it('bounds an unresponsive subprocess handshake and returns only a controlled error', async () => {
  launch(['-e', 'process.stdin.resume(); process.stderr.write("synthetic-secret");']);
  expect(await probeReadIntegration(state, target, 100)).toEqual({ ok: false, code: 'READ_MCP_FAILED' });
});
