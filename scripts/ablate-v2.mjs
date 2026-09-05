import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const disabled = Number.MAX_SAFE_INTEGER;
export const variants = [
  { id: 'baseline', removed: null, scheduler: {} },
  { id: 'no-count', removed: 'turnThreshold', scheduler: { turnThreshold: disabled } },
  { id: 'no-bytes', removed: 'byteThreshold', scheduler: { byteThreshold: disabled } },
  { id: 'no-idle', removed: 'idleMs', scheduler: { idleMs: disabled } },
  { id: 'no-max-wait', removed: 'maxWaitMs', scheduler: { maxWaitMs: disabled } },
  { id: 'no-lifecycle', removed: 'lifecycle', scheduler: {} },
];
const baseline = { turnThreshold: 6, byteThreshold: 16384, idleMs: 120000, maxWaitMs: 600000 };
const tickMs = 1000;
const maxTurns = 6;

export function loadScenarios() {
  const original = JSON.parse(readFileSync(new URL('../fixtures/v2-trajectories.json', import.meta.url), 'utf8'));
  const targeted = JSON.parse(readFileSync(new URL('../fixtures/v2-ablation-scenarios.json', import.meta.url), 'utf8'));
  return [...original.map(fixture => {
    const last = fixture.turns.at(-1).atMs;
    return { id: `original:${fixture.id}`, stratum: 'original-30', turns: fixture.turns.map(turn => ({ atMs: turn.atMs, text: turn.text, scope: fixture.target === 'project' ? 'project:fixture' : 'global' })), events: [{ atMs: last + 1000, kind: 'flush' }], horizonMs: last + 60000 };
  }), ...targeted];
}

function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }
function percentile(values, p) { return values.length ? [...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1] : null; }

function simulate(RuntimeStore, scenario, variant) {
  if (!Number.isSafeInteger(scenario.horizonMs) || scenario.horizonMs < 0 || scenario.horizonMs % tickMs) throw new Error('Invalid observation horizon');
  const root = mkdtempSync(join(tmpdir(), 'memory-ablation-'));
  let now = 0, stable = true, store;
  const options = { ...baseline, ...scenario.scheduler, ...variant.scheduler, now: () => now };
  const arrivals = new Map(), processed = new Map(), batches = [];
  const turns = new Map();
  for (const [index, turn] of scenario.turns.entries()) {
    if (turn.atMs % tickMs || turn.atMs > scenario.horizonMs || turn.atMs < 0) throw new Error('Turn outside common clock/horizon');
    const entries = turns.get(turn.atMs) ?? []; entries.push({ ...turn, index }); turns.set(turn.atMs, entries);
  }
  const events = new Map();
  for (const event of scenario.events ?? []) {
    if (event.atMs % tickMs || event.atMs > scenario.horizonMs || event.atMs < 0 || !['flush', 'close', 'open', 'busy', 'stable'].includes(event.kind)) throw new Error('Invalid lifecycle event');
    const entries = events.get(event.atMs) ?? []; entries.push(event); events.set(event.atMs, entries);
  }
  try {
    store = new RuntimeStore(root, options);
    for (now = 0; now <= scenario.horizonMs; now += tickMs) {
      // Paired convention: all input at t, then host lifecycle at t, then one tick.
      for (const turn of turns.get(now) ?? []) {
        if (!store) throw new Error('Input while session is closed');
        const text = turn.text ?? 'x'.repeat(turn.bytes ?? 32);
        store.enqueue({ sessionId: scenario.id, entryId: String(turn.index), text, source: 'interactive', scope: turn.scope ?? 'global', observedAt: new Date(now).toISOString() });
        arrivals.set(String(turn.index), now);
      }
      for (const event of events.get(now) ?? []) {
        if (event.kind === 'busy') stable = false;
        if (event.kind === 'stable') stable = true;
        if (event.kind === 'flush' && variant.removed !== 'lifecycle') store?.requestFlush();
        if (event.kind === 'close') {
          if (!store) throw new Error('Already closed');
          if (variant.removed !== 'lifecycle') store.requestFlush();
          store.close(); store = undefined;
        }
        if (event.kind === 'open') {
          if (store) throw new Error('Already open');
          store = new RuntimeStore(root, options); stable = true;
        }
      }
      if (!store || !stable) continue;
      // Fix batch capacity separately: removing count must NOT enlarge batches.
      const job = store.claim({ maxTurns });
      if (!job) continue;
      const entries = job.observations.map(observation => observation.entryId);
      if (entries.some(id => processed.has(id))) throw new Error('Duplicate queue consumption');
      for (const id of entries) processed.set(id, now);
      batches.push({ atMs: now, entries });
      // Instant no-op completion isolates scheduling. No model or Canonical mutation.
      store.finish(job);
    }
    const latencyMs = [...processed].map(([id, at]) => at - arrivals.get(id));
    const pendingAgesMs = [...arrivals].filter(([id]) => !processed.has(id)).map(([, at]) => scenario.horizonMs - at);
    const waitToHorizonMs = [...arrivals].map(([id, at]) => (processed.get(id) ?? scenario.horizonMs) - at);
    return { scenario: scenario.id, stratum: scenario.stratum, variant: variant.id, horizonMs: scenario.horizonMs,
      turns: arrivals.size, processed: processed.size, pending: pendingAgesMs.length, maintenanceBatches: batches.length,
      meanProcessedLatencyMs: mean(latencyMs), p95ProcessedLatencyMs: percentile(latencyMs, 0.95),
      oldestPendingAgeMs: pendingAgesMs.length ? Math.max(...pendingAgesMs) : null,
      meanWaitToHorizonMs: mean(waitToHorizonMs), latencyMs, pendingAgesMs, waitToHorizonMs, batches };
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
}

export async function runAblation(RuntimeStore, { scenarios = loadScenarios(), repeats = 3 } = {}) {
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('repeats must be 1..20');
  const records = [];
  for (const scenario of scenarios) for (const variant of variants) {
    let first;
    for (let repeat = 0; repeat < repeats; repeat++) {
      const result = simulate(RuntimeStore, scenario, variant);
      if (first && JSON.stringify(result) !== JSON.stringify(first)) throw new Error(`Non-reproducible result: ${scenario.id}/${variant.id}`);
      first = result;
    }
    records.push(first);
  }
  const summaries = [];
  for (const stratum of [...new Set(scenarios.map(s => s.stratum))]) for (const variant of variants) {
    const rows = records.filter(row => row.stratum === stratum && row.variant === variant.id);
    const sum = key => rows.reduce((total, row) => total + row[key], 0);
    const latencies = rows.flatMap(row => row.latencyMs), waits = rows.flatMap(row => row.waitToHorizonMs);
    const baselineRows = records.filter(row => row.stratum === stratum && row.variant === 'baseline');
    summaries.push({ stratum, variant: variant.id, scenarios: rows.length, turns: sum('turns'), processed: sum('processed'), pending: sum('pending'),
      coverage: sum('processed') / sum('turns'), maintenanceBatches: sum('maintenanceBatches'),
      meanProcessedLatencyMs: mean(latencies), p95ProcessedLatencyMs: percentile(latencies, 0.95), meanWaitToHorizonMs: mean(waits),
      deltaBatches: sum('maintenanceBatches') - baselineRows.reduce((total, row) => total + row.maintenanceBatches, 0),
      deltaPending: sum('pending') - baselineRows.reduce((total, row) => total + row.pending, 0),
      deltaMeanWaitToHorizonMs: mean(waits) - mean(baselineRows.flatMap(row => row.waitToHorizonMs)) });
  }
  return { experiment: 'v2-scheduler-one-factor-ablation', mode: 'offline-runtime-queue', semanticQualityVerified: false,
    modelCalls: 0, tokensMeasured: false, repeats, scenarioCount: scenarios.length, executions: scenarios.length * variants.length * repeats,
    fixtureDigest: createHash('sha256').update(JSON.stringify(scenarios)).digest('hex'), baseline, maxTurns, tickMs,
    eventOrder: ['enqueue', 'lifecycle', 'one-stable-tick'], terminalForcedFlush: false,
    assumptions: ['instant no-op maintenance', 'fixed 6-turn batch capacity', 'right-censor at common per-scenario horizon', 'sensitivity-high-count is not pooled with defaults'], summaries, records };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => !/^--(?:repeats=\d+|output=.+)$/.test(arg))) throw new Error('Usage: node scripts/ablate-v2.mjs [--repeats=3] [--output=path] (offline only)');
  const { RuntimeStore } = await import('../dist/v2/runtime.js');
  const repeats = Number(args.find(arg => arg.startsWith('--repeats='))?.slice(10) ?? 3);
  const report = await runAblation(RuntimeStore, { repeats });
  report.nodeVersion = process.version;
  report.harnessDigest = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
  report.runtimeArtifactDigest = createHash('sha256').update(readFileSync(new URL('../dist/v2/runtime.js', import.meta.url))).digest('hex');
  const output = args.find(arg => arg.startsWith('--output='))?.slice(9);
  const json = JSON.stringify(report, null, 2) + '\n';
  if (output) writeFileSync(output, json); else process.stdout.write(json);
}
