import { stubInstalledBuild } from '../helpers/installation-build.js';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildIntegrationMigrationPlan, discoverIntegrationCandidates } from '../../src/cli/integration-migration.js';
import { reconcileIntegrations } from '../../src/cli/integrations.js';
import { defaultConfig, saveConfig } from '../../src/config/config.js';

let root: string, home: string, codex: string, pi: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cm-integration-migration-')));
  home = join(root, 'home'); codex = join(root, 'codex'); pi = join(root, 'pi');
  vi.stubEnv('COMMON_MEMORY_HOME', home); stubInstalledBuild();
  const config = defaultConfig(); config.remote.model = 'synthetic'; saveConfig(config);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it('discovers actionable structural legacy MCP/Pi registrations without writing, then replaces them atomically with the current owned graph', () => {
  mkdirSync(codex, { recursive: true }); mkdirSync(pi, { recursive: true });
  const mcp = '# common-memory:0123456789ab:begin\n[mcp_servers.common_memory]\ncommand = "/old/common-memory-core/dist/cli/main.js"\nargs = ["mcp"]\n# common-memory:0123456789ab:end\n\n[mcp_servers.other]\ncommand = "other"\n';
  const settings = JSON.stringify({ theme: 'dark', extensions: ['/old/common-memory.js', '/user/keep.js'] }, null, 2) + '\n';
  writeFileSync(join(codex, 'config.toml'), mcp); writeFileSync(join(pi, 'settings.json'), settings);
  const candidates = discoverIntegrationCandidates([{ id: 'codex', root: codex }, { id: 'pi', root: pi }]);
  expect(candidates.map(c => [c.id, c.kind, c.status, c.selector])).toEqual([
    ['codex', 'mcp', 'actionable', 'mcp_servers.common_memory'],
    ['pi', 'pi', 'actionable', 'extensions[0]'],
  ]);
  expect(readFileSync(join(codex, 'config.toml'), 'utf8')).toBe(mcp);
  expect(readFileSync(join(pi, 'settings.json'), 'utf8')).toBe(settings);

  const migration = buildIntegrationMigrationPlan(candidates);
  reconcileIntegrations([{ id: 'codex', name: 'Codex', root: codex, mode: 'posix', hooks: false }], join(home, 'data'), { home, migration });
  const next = readFileSync(join(codex, 'config.toml'), 'utf8');
  expect(next).toContain('[mcp_servers.other]');
  expect(next).toContain('# common-memory:');
  expect(next).not.toContain('/old/common-memory-core');
  expect(next).not.toContain('# common-memory:0123456789ab:');
  // The unselected Pi candidate is removed in the same transaction without touching unrelated values.
  expect(JSON.parse(readFileSync(join(pi, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark', extensions: ['/user/keep.js'] });
});

it('reports ambiguous name-only and malformed registrations as blocking paths and refuses to build a write plan', () => {
  mkdirSync(codex, { recursive: true });
  writeFileSync(join(codex, 'config.toml'), '[mcp_servers.common_memory]\ncommand = "user-owned"\n');
  let candidates = discoverIntegrationCandidates([{ id: 'codex', root: codex }]);
  expect(candidates).toMatchObject([{ path: join(codex, 'config.toml'), status: 'blocked', reason: 'command-unverified' }]);
  expect(() => buildIntegrationMigrationPlan(candidates)).toThrow('无法安全迁移');

  writeFileSync(join(codex, 'config.toml'), '[mcp_servers.common_memory\ncommand = "common-memory"\n');
  candidates = discoverIntegrationCandidates([{ id: 'codex', root: codex }]);
  expect(candidates).toMatchObject([{ path: join(codex, 'config.toml'), status: 'blocked', reason: 'toml-malformed' }]);
});

it('does not offer a managed registration for migration even though every ownership state is scanned', () => {
  mkdirSync(codex, { recursive: true });
  const body = '# common-memory:abc:begin\n[mcp_servers.common_memory]\ncommand = "/current/common-memory-core/dist/cli/main.js"\n# common-memory:abc:end\n';
  writeFileSync(join(codex, 'config.toml'), body);
  const candidates = discoverIntegrationCandidates([{ id: 'codex', root: codex }], { managed: [{ path: join(codex, 'config.toml'), kind: 'toml', content: body, owners: ['codex'] }] });
  expect(candidates).toMatchObject([{ status: 'managed', selector: 'mcp_servers.common_memory' }]);
  expect(buildIntegrationMigrationPlan(candidates).changes).toEqual([]);
});

it('removes only a nested Common Memory hook handler, retaining its matcher and sibling handlers', () => {
  mkdirSync(codex, { recursive: true });
  const path = join(codex, 'hooks.json');
  writeFileSync(path, JSON.stringify({ hooks: { UserPromptSubmit: [{ matcher: 'keep', hooks: [
    { type: 'command', command: '/old/common-memory-core/dist/cli/main.js codex-hook' },
    { type: 'command', command: 'user-hook' },
  ] }] } }, null, 2));
  const candidates = discoverIntegrationCandidates([{ id: 'codex', root: codex }]);
  expect(candidates).toMatchObject([{ kind: 'hook', selector: 'hooks.UserPromptSubmit[0].hooks[0]', status: 'actionable' }]);
  const change = buildIntegrationMigrationPlan(candidates).changes[0]!;
  expect(JSON.parse(change.after!).hooks.UserPromptSubmit).toEqual([{ matcher: 'keep', hooks: [{ type: 'command', command: 'user-hook' }] }]);
});

it('uses only launch fields as proof, validates nested TOML removal semantically, and supports a Pi package source object', () => {
  mkdirSync(codex, { recursive: true }); mkdirSync(pi, { recursive: true });
  const toml = '[mcp_servers.common_memory]\ncommand = "/old/common-memory-core/dist/cli/main.js"\n[mcp_servers.common_memory.env]\nNOTE = "not evidence"\ndescription = """\n[mcp_servers.not_a_header]\n"""\n\n[mcp_servers.other]\ncommand = "other"\n[mcp_servers.other.env]\nDESCRIPTION = "common-memory is only text"\n';
  writeFileSync(join(codex, 'config.toml'), toml);
  writeFileSync(join(codex, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'other', description: 'common-memory only text' }] }] } }));
  writeFileSync(join(pi, 'settings.json'), JSON.stringify({ packages: [
    { source: 'npm:common-memory-core', extensions: ['./index.js'] },
    { source: 'npm:other', description: 'common-memory only text' },
  ] }));
  const candidates = discoverIntegrationCandidates([{ id: 'codex', root: codex }, { id: 'pi', root: pi }]);
  expect(candidates.map(candidate => candidate.selector)).toEqual(['mcp_servers.common_memory', 'packages[0]']);
  const changes = buildIntegrationMigrationPlan(candidates).changes;
  expect(changes.find(change => change.path.endsWith('config.toml'))!.after).toContain('[mcp_servers.other]');
  expect(changes.find(change => change.path.endsWith('settings.json'))!.after).toContain('npm:other');
});
