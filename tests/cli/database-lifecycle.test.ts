import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, saveConfig } from '../../src/config/config.js';
import { RuntimeStore } from '../../src/v2/runtime.js';
import * as sqlite from '../../src/v2/sqlite.js';
import { enqueueCodexEvent, consumeCodexInbox, type CodexEvent } from '../../src/cli/host-session.js';
import { refreshSession } from '../../src/cli/codex-hook.js';
import { assertDeletableData } from '../../src/cli/uninstall.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cm-db-lifecycle-')); vi.stubEnv('COMMON_MEMORY_HOME', home); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

it.each(['enqueue', 'consume', 'refresh'] as const)('closes the connection when %s cannot initialize host tables', async operation => {
  const config = defaultConfig(); config.remote.model = 'synthetic'; saveConfig(config);
  const initial = new RuntimeStore(config.dataRoot);
  // A real schema incompatibility, after the base runtime has successfully opened.
  initial.db.exec('CREATE VIEW codex_candidates AS SELECT 1 AS id'); initial.close();
  const open = vi.spyOn(sqlite, 'openDatabase');
  const event: CodexEvent = { hook_event_name: 'SessionStart', cwd: home, session_id: 'synthetic', transcript_path: join(home, 'unused.jsonl') };
  await expect(async () => {
    if (operation === 'enqueue') enqueueCodexEvent(config, event, 'synthetic');
    else if (operation === 'consume') await consumeCodexInbox(config);
    else refreshSession(home, 'codex', 'synthetic', 'synthetic');
  }).rejects.toThrow(/view/i);
  expect(open).toHaveBeenCalledOnce();
  const db = open.mock.results[0]!.value as RuntimeStore['db'];
  expect(() => db.prepare('SELECT 1')).toThrow(/not open|closed/i);
  const reopened = new RuntimeStore(config.dataRoot);
  try { reopened.db.exec('BEGIN EXCLUSIVE; DROP VIEW codex_candidates; COMMIT'); }
  finally { reopened.close(); }
});

it('closes a runtime whose schema migration fails', () => {
  const config = defaultConfig();
  const initial = new RuntimeStore(config.dataRoot);
  initial.db.exec('DROP TABLE jobs; CREATE VIEW jobs AS SELECT 1 AS id'); initial.close();
  const open = vi.spyOn(sqlite, 'openDatabase');
  expect(() => new RuntimeStore(config.dataRoot)).toThrow();
  expect(() => open.mock.results[0]!.value.prepare('SELECT 1')).toThrow(/not open|closed/i);
});

it('keeps uninstall lease checks read-only and closes even when the query fails', () => {
  const config = defaultConfig();
  const initial = new RuntimeStore(config.dataRoot); initial.db.exec('DROP TABLE jobs'); initial.close();
  const open = vi.spyOn(sqlite, 'openDatabase');
  expect(() => assertDeletableData(config)).toThrow(/no such table/i);
  expect(open).toHaveBeenCalledWith(join(config.dataRoot, 'runtime.sqlite'), { readOnly: true, timeout: 100 });
  expect(() => open.mock.results[0]!.value.prepare('SELECT 1')).toThrow(/not open|closed/i);
});
