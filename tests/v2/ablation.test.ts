import { expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { RuntimeStore } from '../../src/v2/runtime.js';

interface Row {
  variant: string;
  processed: number;
  pending: number;
  maintenanceBatches: number;
  meanWaitToHorizonMs: number;
  batches: { atMs: number; entries: string[] }[];
}
const experiment = await import(pathToFileURL(resolve('scripts/ablate-v2.mjs')).href);

// Core scheduler boundaries live in runtime*.test.ts. The default gate checks
// the report harness, not the entire benchmark matrix or a fixed fixture count.
it('reports a paired restart/flush counterfactual with censored pending work and reproducible repeats', async () => {
  const report = await experiment.runAblation(RuntimeStore, { repeats: 2, scenarios: [{
    id: 'restart-tail', stratum: 'test', turns: [{ atMs: 0 }],
    events: [{ atMs: 1000, kind: 'close' }, { atMs: 2000, kind: 'open' }], horizonMs: 3000,
  }] });
  expect(report).toMatchObject({ modelCalls: 0, semanticQualityVerified: false, terminalForcedFlush: false, executions: 12 });
  expect(report.records).toHaveLength(6);
  for (const row of report.records as Row[]) {
    const noFlush = row.variant === 'no-lifecycle';
    expect(row).toMatchObject({
      processed: noFlush ? 0 : 1, pending: noFlush ? 1 : 0,
      maintenanceBatches: noFlush ? 0 : 1, meanWaitToHorizonMs: noFlush ? 3000 : 2000,
      batches: noFlush ? [] : [{ atMs: 2000, entries: ['0'] }],
    });
    expect(report.summaries.find((summary: Row) => summary.variant === row.variant)).toMatchObject({
      processed: row.processed, pending: row.pending, maintenanceBatches: row.maintenanceBatches,
      meanWaitToHorizonMs: row.meanWaitToHorizonMs,
      deltaPending: noFlush ? 1 : 0, deltaBatches: noFlush ? -1 : 0,
    });
  }
});

it('keeps enqueue-before-tick ordering and fixed batch capacity when count is disabled', async () => {
  const report = await experiment.runAblation(RuntimeStore, { repeats: 1, scenarios: [
    { id: 'capacity', stratum: 'test', turns: Array.from({ length: 20 }, () => ({ atMs: 0 })), horizonMs: 125000 },
    { id: 'deadline-tie', stratum: 'test', turns: [{ atMs: 0 }, { atMs: 120000 }], horizonMs: 120000 },
  ] });
  const rows = report.records as (Row & { scenario: string })[];
  const removed = rows.find(r => r.scenario === 'capacity' && r.variant === 'no-count')!;
  expect(removed.processed).toBe(20);
  expect(removed.batches.map(b => b.entries.length)).toEqual([6, 6, 6, 2]);
  expect(rows.find(r => r.scenario === 'deadline-tie' && r.variant === 'baseline')!.pending).toBe(2);
  await expect(experiment.runAblation(RuntimeStore, { scenarios: [], repeats: 0 })).rejects.toThrow('repeats must be 1..20');
});
