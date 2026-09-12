import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { defaultConfig, saveConfig } from '../../src/config/config.js';
import * as sqlite from '../../src/v2/sqlite.js';
import { createCommonMemoryPiExtension } from '../../src/pi-extension/index.js';
import { runMcp } from '../../src/mcp/stdio.js';

// Inject host startup failures after a real configured Writer has opened its files.
vi.mock('../../src/pi-extension/extraction-runtime.js', () => ({ PiCaptureRuntime: class {
  constructor() { throw new Error('SYNTHETIC_PI_STARTUP_FAILURE'); }
} }));
vi.mock('@modelcontextprotocol/server/stdio', async importOriginal => ({
  ...await importOriginal<object>(), serveStdio() { throw new Error('SYNTHETIC_MCP_STARTUP_FAILURE'); },
}));

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cm-host-cleanup-')); vi.stubEnv('COMMON_MEMORY_HOME', home); vi.stubEnv('CM_CLEANUP_TEST_KEY', 'synthetic'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

it.each(['pi', 'mcp'])('closes real database connections when %s startup fails', async host => {
  const config = defaultConfig();
  config.remote = { provider: 'openai-compatible', model: 'synthetic', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'CM_CLEANUP_TEST_KEY' };
  saveConfig(config);
  const open = vi.spyOn(sqlite, 'openDatabase');
  if (host === 'mcp') {
    await expect(runMcp(['--client-id', 'synthetic', '--global'])).rejects.toThrow('SYNTHETIC_MCP_STARTUP_FAILURE');
  } else {
    const handlers = new Map<string, () => void>();
    const pi = { on: (name: string, handler: () => void) => handlers.set(name, handler), registerTool() {}, registerCommand() {} } as unknown as ExtensionAPI;
    createCommonMemoryPiExtension({ configFactory: () => config })(pi);
    const diagnostic = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    handlers.get('agent_start')!();
    await setImmediate();
    expect(diagnostic).toHaveBeenCalled();
  }
  expect(open.mock.results.length).toBeGreaterThan(0);
  for (const result of open.mock.results) expect(() => result.value.prepare('SELECT 1')).toThrow(/not open|closed/i);
});
