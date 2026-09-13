import type { MemoryReadPort, MemoryTask } from '../../src/core/contracts/memory-agent.js';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/config/config.js';
import { createConfiguredMemoryAgent } from '../../src/config/runtime.js';
import { runNetworkTest } from '../../src/cli/network-test.js';

vi.mock('../../src/config/runtime.js', () => ({ createConfiguredMemoryAgent: vi.fn(), describeConfiguredNetwork: () => ({ mode: 'direct', route: 'direct', reason: 'direct_mode' }) }));
afterEach(() => vi.resetAllMocks());
it('returns structured probe results through an injected logger and closes the borrowed CLI operation', async () => {
  const config = defaultConfig(); config.remote.model = 'synthetic';
  const close = vi.fn().mockResolvedValue(undefined);
  const decide = vi.fn(async (task:MemoryTask, reads:MemoryReadPort) => { reads.manifest('probe'); reads.read('probe','probe-text'); return {body:{version:'memory_maintenance_v2',request_id:task.request_id,decisions:[{kind:'ignore',applicability:'global',confidence:1,evidence:[],reason:'synthetic'}]},usage:{},promptDigest: 'ba9c736f19e7f60b7f6764adb0b7908c0a2b394e09b6c09863528c7f2bc86095'}; });
  vi.mocked(createConfiguredMemoryAgent).mockReturnValue({ decide, close } as unknown as ReturnType<typeof createConfiguredMemoryAgent>);
  const lines: string[] = [];
  const signals = process.listenerCount('SIGINT');
  expect(await runNetworkTest(config, line => lines.push(line))).toBe(0);
  expect(JSON.parse(lines[1]!)).toMatchObject({ passed: true, writerCommitTested: false });
  expect(close).toHaveBeenCalledTimes(1);
  expect(process.listenerCount('SIGINT')).toBe(signals);
  expect(decide.mock.calls[0]![0].request_id).toBe('network-test');
});
it('Ctrl+C aborts the active probe, cleans up listeners/connections, and returns incomplete instead of exiting the TUI', async () => {
  const config = defaultConfig(); config.remote.model = 'synthetic';
  const close = vi.fn().mockResolvedValue(undefined);
  const decide = vi.fn(async (_request: unknown, _reads: unknown, options: { signal: AbortSignal }) => {
    process.emit('SIGINT');
    options.signal.throwIfAborted();
  });
  vi.mocked(createConfiguredMemoryAgent).mockReturnValue({ decide, close } as unknown as ReturnType<typeof createConfiguredMemoryAgent>);
  const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM'), exitCode: process.exitCode };
  const lines: string[] = [];
  expect(await runNetworkTest(config, line => lines.push(line))).toBe(1);
  expect(JSON.parse(lines[1]!)).toMatchObject({ passed: false });
  expect(close).toHaveBeenCalledTimes(1);
  expect(process.listenerCount('SIGINT')).toBe(before.int);
  expect(process.listenerCount('SIGTERM')).toBe(before.term);
  expect(process.exitCode).toBe(before.exitCode);
});
