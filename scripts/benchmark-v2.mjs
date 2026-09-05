/** Offline microbenchmark. Build first; --baseline points at a preserved dist directory. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')));
const candidate = resolve(args.candidate ?? 'dist');
const baseline = args.baseline ? resolve(args.baseline) : null;
const warmups = 2, samples = 9, now = 2_000_000_000_000;
const workloads = [
  { name: 'idle-small', kind: 'idle', history: 20, pending: 0, receipts: 0, iterations: 10 },
  { name: 'idle-history-20k', kind: 'idle', history: 20000, pending: 0, receipts: 0, iterations: 10 },
  { name: 'claim-small', kind: 'claim', history: 20, pending: 6, receipts: 0, iterations: 3 },
  { name: 'claim-auto-backlog-2k', kind: 'claim', force: false, history: 20000, pending: 2000, receipts: 0, iterations: 3 },
  { name: 'open-existing-history-20k', kind: 'open', history: 20000, pending: 0, receipts: 0, iterations: 1 },
  { name: 'claim-backlog-2k', kind: 'claim', history: 20000, pending: 2000, receipts: 0, iterations: 3 },
  { name: 'recover-small', kind: 'recover', history: 0, pending: 0, receipts: 2, iterations: 1 },
  { name: 'recover-confirmed-500', kind: 'recover', history: 0, pending: 0, receipts: 500, iterations: 1 },
];
const modules = new Map();
for (const directory of new Set([baseline, candidate].filter(Boolean))) {
  const { RuntimeStore } = await import(pathToFileURL(join(directory, 'v2/runtime.js')));
  const { Writer } = await import(pathToFileURL(join(directory, 'v2/writer.js')));
  modules.set(directory, { RuntimeStore, Writer });
}
const hash = text => createHash('sha256').update(text).digest('hex');
const rollback = new Error('benchmark rollback');
function fixture(directory, workload) {
  const root = mkdtempSync(join(tmpdir(), 'cm-benchmark-'));
  const { RuntimeStore, Writer } = modules.get(directory);
  const SeedStore = workload.kind === 'open' ? modules.get(baseline ?? directory).RuntimeStore : RuntimeStore;
  const store = new SeedStore(root, { now: () => now });
  const text = 'a'.repeat(4096), digest = hash(text);
  store.transaction(() => {
    const observation = store.db.prepare('INSERT INTO observations(sessionId,entryId,text,digest,scope,observedAt,source,state,enqueuedAt,processedAt,jobId) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    const job = store.db.prepare("INSERT INTO jobs VALUES(?,?,1,'done',0,1,0,NULL)");
    for (let i = 0; i < workload.history; i++) {
      job.run(`history-${i}`, `token-${i}`);
      observation.run('history', `${i}`, null, digest, 'global', new Date(now).toISOString(), 'interactive', 'processed', now - 1e9, now - 1e9, `history-${i}`);
    }
    for (let i = 0; i < workload.pending; i++) observation.run('pending', `${i}`, text, digest, 'global', new Date(now).toISOString(), 'interactive', 'pending', now, null, null);
    if (workload.receipts) {
      mkdirSync(join(root, 'runtime/receipts'), { recursive: true });
      mkdirSync(join(root, 'memory'), { recursive: true });
      const canonical = '# Profile\n\n## Fixture\nSynthetic benchmark state.\n';
      writeFileSync(join(root, 'memory/profile.md'), canonical);
      for (let i = 0; i < workload.receipts; i++) {
        const id = `receipt-${String(i).padStart(5, '0')}`;
        job.run(id, id);
        const inserted = observation.run('receipt', `${i}`, null, digest, 'global', new Date(now).toISOString(), 'interactive', 'processed', now, now, id);
        const sourceId = Number(inserted.lastInsertRowid);
        store.db.prepare('INSERT INTO receipts VALUES(?)').run(id);
        // Fully shaped immutable Writer receipt; confirmed bodies intentionally stay absent.
        writeFileSync(join(root, 'runtime/receipts', `${id}.json`), JSON.stringify({
          id, jobId: id, version: 2, observationIds: [sourceId], associations: [], removeTargets: [], forgetSourceIds: [],
          decisions: ['retain'], promptDigest: hash('fixture'), modelVersion: 'offline-fixture', timestamp: new Date(now).toISOString(),
          usage: { inputTokens: 10, outputTokens: 10 }, sources: [{ id: sourceId, sessionId: 'receipt', entryId: `${i}`, digest }],
          documents: [{ target: 'profile', before: i === 0 ? 'missing' : hash(canonical), after: hash(canonical) }],
        }) + '\n');
      }
    }
  });
  let writer;
  if (workload.kind === 'recover') {
    store.close();
    writer = new Writer({ dataRoot: root, allowedScopes: ['global'], scheduler: { now: () => now }, model: { analyze() { throw new Error('Unexpected model call'); } } });
  }
  let active = writer?.store ?? store;
  if (workload.kind === 'open') store.close();
  let selected, idleHasWork;
  const operation = () => {
    if (workload.kind === 'open') active = new RuntimeStore(root, { now: () => now });
    else if (workload.kind === 'idle') { active.pruneProcessed(); idleHasWork = active.hasWork(); }
    else if (workload.kind === 'recover') writer.recover();
    else {
      try { active.transaction(() => { selected = active.claim({ force: workload.force ?? true, maxTurns: 6 }); throw rollback; }); }
      catch (error) { if (error !== rollback) throw error; }
    }
  };
  const verify = () => {
    if (workload.kind === 'idle') assert.equal(idleHasWork, false);
    if (workload.kind === 'recover') assert.equal(readFileSync(join(root, 'memory/profile.md'), 'utf8'), '# Profile\n\n## Fixture\nSynthetic benchmark state.\n');
    if (workload.kind === 'claim') {
      assert.deepEqual(selected.observations.map(o => o.id), Array.from({ length: 6 }, (_, i) => workload.history + i + 1));
      assert.ok(selected.observations.every(o => o.text === text && o.scope === 'global'));
      assert.equal(active.db.prepare("SELECT count(*) n FROM observations WHERE state='pending'").get().n, workload.pending);
      assert.equal(active.db.prepare("SELECT count(*) n FROM jobs WHERE state='running'").get().n, 0);
    }
    assert.equal(active.db.prepare('SELECT count(*) n FROM receipts').get().n, workload.receipts);
    assert.equal(active.db.prepare('SELECT count(*) n FROM observations').get().n, workload.history + workload.pending + workload.receipts);
    assert.equal(active.db.prepare("SELECT count(*) n FROM observations WHERE state='processed' AND text IS NOT NULL").get().n, 0);
  };
  return { operation, verify, close() { active.close(); rmSync(root, { recursive: true, force: true }); } };
}
function sample(directory, workload) {
  const f = fixture(directory, workload);
  try {
    const start = performance.now();
    for (let i = 0; i < workload.iterations; i++) f.operation();
    const elapsed = (performance.now() - start) / workload.iterations;
    f.verify(); return elapsed;
  } finally { f.close(); }
}
function summary(values) {
  const sorted = [...values].sort((a,b) => a-b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], samplesMs: values };
}
const results = [];
for (const workload of workloads) {
  const values = { baseline: [], candidate: [] };
  for (let i = -warmups; i < samples; i++) {
    // Alternate order to reduce monotonic thermal/cache bias; fixtures never share dataRoots.
    const order = baseline ? (i % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) : ['candidate'];
    for (const name of order) { const elapsed = sample(name === 'baseline' ? baseline : candidate, workload); if (i >= 0) values[name].push(elapsed); }
  }
  const result = { ...workload, candidate: summary(values.candidate) };
  if (baseline) { result.baseline = summary(values.baseline); result.medianSpeedup = result.baseline.medianMs / result.candidate.medianMs; }
  results.push(result); console.error(`${workload.name}: ${result.candidate.medianMs.toFixed(3)} ms${baseline ? ` (${result.medianSpeedup.toFixed(2)}x)` : ''}`);
}
const treeFingerprint = directory => {
  const files = readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const full = join(entry.parentPath, entry.name); return [full.slice(directory.length + 1), hash(readFileSync(full))];
  }).sort(([a], [b]) => a.localeCompare(b));
  return { sha256: hash(JSON.stringify(files)), files: Object.fromEntries(files) };
};
const fingerprint = directory => Object.fromEntries(['runtime', 'writer', 'canonical'].map(name => [name, hash(readFileSync(join(directory, `v2/${name}.js`)))]));
const report = {
  version: 1, generatedAt: new Date().toISOString(), command: `node ${process.argv.slice(1).join(' ')}`,
  environment: { node: process.version, platform: platform(), release: release(), arch: process.arch, cpu: cpus()[0]?.model },
  method: { samples, warmups, unit: 'milliseconds/operation', fixtureSetupTimed: false, firstOpen: 'open-existing-history-20k is seeded using baseline schema and includes constructor/index creation; other cases exclude constructor', order: 'alternating baseline/candidate', modelCalls: 0, semanticAssertions: true, timingAssertions: false,
    limitations: ['Synthetic local SQLite/filesystem workloads; not real model latency, token cost, or semantic quality.', 'Recover measures repeated recovery after constructor startup, not cold startup.', 'p95 is nearest-rank over nine samples; use repeated runs before generalizing.'] },
  compiledTrees: { candidate: treeFingerprint(candidate), ...(baseline ? { baseline: treeFingerprint(baseline) } : {}) },
  modules: { candidate: fingerprint(candidate), ...(baseline ? { baseline: fingerprint(baseline) } : {}) }, results,
};
if (args.output) writeFileSync(resolve(args.output), JSON.stringify(report, null, 2) + '\n');
else console.log(JSON.stringify(report, null, 2));
