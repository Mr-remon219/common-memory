import { afterEach, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/config/config.js';
import { createConfiguredMemoryModel } from '../../src/config/runtime.js';
import { runNetworkTest } from '../../src/cli/network-test.js';

vi.mock('../../src/config/runtime.js', () => ({ createConfiguredMemoryModel: vi.fn(), describeConfiguredNetwork: () => ({ mode: 'direct', route: 'direct', reason: 'direct_mode' }) }));
afterEach(() => vi.resetAllMocks());
it('returns structured probe results through an injected logger and closes the borrowed CLI operation', async () => {
  const config = defaultConfig(); config.remote.model = 'synthetic';
  const close = vi.fn().mockResolvedValue(undefined);
  const analyze = vi.fn().mockResolvedValue({ kind: 'output', body: { ok: true } });
  vi.mocked(createConfiguredMemoryModel).mockReturnValue({ analyze, close } as unknown as ReturnType<typeof createConfiguredMemoryModel>);
  const lines: string[] = [];
  const signals = process.listenerCount('SIGINT');
  expect(await runNetworkTest(config, line => lines.push(line))).toBe(0);
  expect(JSON.parse(lines[1]!)).toMatchObject({ passed: true, writerCommitTested: false });
  expect(close).toHaveBeenCalledTimes(1);
  expect(process.listenerCount('SIGINT')).toBe(signals);
  expect(analyze.mock.calls[0]![0].projection).toEqual({ probe: 'Common Memory connection test; synthetic data only' });
});
it('Ctrl+C aborts the active probe, cleans up listeners/connections, and returns incomplete instead of exiting the TUI', async () => {
  const config = defaultConfig(); config.remote.model = 'synthetic';
  const close = vi.fn().mockResolvedValue(undefined);
  const analyze = vi.fn(async (_request: unknown, options: { signal: AbortSignal }) => {
    process.emit('SIGINT');
    options.signal.throwIfAborted();
  });
  vi.mocked(createConfiguredMemoryModel).mockReturnValue({ analyze, close } as unknown as ReturnType<typeof createConfiguredMemoryModel>);
  const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM'), exitCode: process.exitCode };
  const lines: string[] = [];
  expect(await runNetworkTest(config, line => lines.push(line))).toBe(1);
  expect(JSON.parse(lines[1]!)).toMatchObject({ passed: false });
  expect(close).toHaveBeenCalledTimes(1);
  expect(process.listenerCount('SIGINT')).toBe(before.int);
  expect(process.listenerCount('SIGTERM')).toBe(before.term);
  expect(process.exitCode).toBe(before.exitCode);
});
