#!/usr/bin/env node
// One portable gate shared by local work, CI, and prepublish.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (Number(process.versions.node.split('.')[0]) !== 24) {
  console.error('Common Memory verification requires Node 24.x.');
  process.exit(2);
}
const tsc = join(root, 'node_modules/typescript/bin/tsc');
const vitest = join(root, 'node_modules/vitest/vitest.mjs');
if (![tsc, vitest].every(existsSync)) {
  console.error('Dependencies are missing. Run npm ci in this checkout, then retry.');
  process.exit(2);
}
const steps = [
  ['typecheck', [tsc, '-p', 'tsconfig.json', '--noEmit']],
  ['boundaries', [join(root, 'scripts/check-boundaries.mjs')]],
  ['tests', [vitest, 'run']],
  ['build', [join(root, 'scripts/build.mjs')]],
];
for (const [name, args] of steps) {
  console.log(`\n[verify] ${name}`);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', timeout: 300_000 });
  if (result.error || result.status !== 0) {
    console.error(`[verify] stopped at ${name}: ${result.error?.message ?? `exit ${result.status}, signal ${result.signal ?? 'none'}`}`);
    process.exit(result.status || 1);
  }
}
console.log('\n[verify] all checks passed');
