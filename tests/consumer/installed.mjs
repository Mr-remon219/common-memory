// Copied into a fresh consumer directory by scripts/consumer-smoke.mjs.
// Every package import here resolves from the installed tarball, not the checkout.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writer, RuntimeStore, defaultConfig, readAuthorizedMemory } from 'common-memory-core';

const root = fileURLToPath(new URL('.', import.meta.url));
const dataRoot = join(root, 'writer-data');
let calls = 0;
const writer = new Writer({ dataRoot, allowedScopes: ['global'], model: {
  async analyze(request) {
    calls++;
    assert.ok(request.prompt.trim(), 'Packaged maintainer must reach the model port');
    return { kind: 'output', body: {
      version: 'memory_maintenance_v2', request_id: request.projection.request_id,
      decisions: [{ kind: 'retain', admission: 'remember', lifetime: 'until_changed', applicability: 'global', confidence: 1,
        evidence: request.projection.observations.map(observation => observation.ref), reason: 'Synthetic package smoke',
        operations: [{ op: 'put_section', target: 'preferences', section: null, title: 'Package smoke', body: 'Prefers concise synthetic examples.\n' }],
      }],
    } };
  },
} });
try {
  assert.deepEqual(await writer.run(), { outcome: 'idle' });
  assert.equal(calls, 0);
  writer.store.enqueue({ sessionId: 'package-smoke', entryId: 'one', text: 'Please use concise synthetic examples.', scope: 'global', source: 'interactive', observedAt: new Date().toISOString() });
  assert.deepEqual(await writer.run({ force: true }), { outcome: 'committed' });
  assert.equal(calls, 1);
} finally { writer.close(); }
const restarted = new RuntimeStore(dataRoot);
try {
  const outcome = restarted.observationOutcome('package-smoke', 'one');
  assert.equal(outcome.state, 'processed');
  assert.deepEqual(outcome.retainedIn, ['preferences']);
} finally { restarted.close(); }
assert.equal(readdirSync(join(dataRoot, 'runtime/receipts')).length, 1);
assert.match(JSON.stringify(readAuthorizedMemory({ dataRoot, contexts: ['global'] })), /Prefers concise synthetic examples/);
const packageRoot = new URL('../', import.meta.resolve('common-memory-core'));
const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'));
for (const extension of manifest.pi.extensions) {
  const loaded = await import(new URL(extension, packageRoot).href);
  assert.equal(typeof loaded.default, 'function');
}
const config = defaultConfig({ COMMON_MEMORY_HOME: root });
config.remote.model = 'synthetic'; config.remote.proxy = { mode: 'direct' };
writeFileSync(join(root, 'synthetic-config.json'), JSON.stringify(config));
console.log('Installed exports committed once and survived restart; packaged Pi entry loaded.');
