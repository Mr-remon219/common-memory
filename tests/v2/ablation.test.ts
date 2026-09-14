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
it('reports reproducible immediate scheduling; deprecated readiness variants have no comparative effect', async () => {
  const report = await experiment.runAblation(RuntimeStore, { repeats: 2, scenarios: [{
    id: 'restart-tail', stratum: 'test', turns: [{ atMs: 0 }],
    events: [{ atMs: 1000, kind: 'close' }, { atMs: 2000, kind: 'open' }], horizonMs: 3000,
  }] });
  expect(report).toMatchObject({ modelCalls: 0, semanticQualityVerified: false, terminalForcedFlush: false, executions: 12 });
  expect(report.records).toHaveLength(6);
  for (const row of report.records as Row[]) {
    expect(row).toMatchObject({processed:1,pending:0,maintenanceBatches:1,meanWaitToHorizonMs:0,batches:[{atMs:0,entries:['0']}]});
    expect(report.summaries.find((summary: Row) => summary.variant === row.variant)).toMatchObject({
      processed:1,pending:0,maintenanceBatches:1,meanWaitToHorizonMs:0,deltaPending:0,deltaBatches:0,
    });
  }
});

it('keeps fixed legacy batch capacity while deprecated readiness knobs do not change scheduling', async () => {
  const report = await experiment.runAblation(RuntimeStore, { repeats: 1, scenarios: [
    { id: 'capacity', stratum: 'test', turns: Array.from({ length: 20 }, () => ({ atMs: 0 })), horizonMs: 125000 },
    { id: 'deadline-tie', stratum: 'test', turns: [{ atMs: 0 }, { atMs: 120000 }], horizonMs: 120000 },
  ] });
  const rows = report.records as (Row & { scenario: string })[];
  for (const scenario of ['capacity','deadline-tie']) {
    const baseline=rows.find(row=>row.scenario===scenario&&row.variant==='baseline')!;
    for(const row of rows.filter(row=>row.scenario===scenario))expect(row).toMatchObject({processed:baseline.processed,pending:baseline.pending,maintenanceBatches:baseline.maintenanceBatches,batches:baseline.batches});
  }
  expect(rows.find(r => r.scenario === 'capacity' && r.variant === 'baseline')!.batches.map(b => b.entries.length)).toEqual([6,6,6,2]);
  expect(rows.find(r => r.scenario === 'deadline-tie' && r.variant === 'baseline')!).toMatchObject({processed:2,pending:0});
  await expect(experiment.runAblation(RuntimeStore, { scenarios: [], repeats: 0 })).rejects.toThrow('repeats must be 1..20');
});
