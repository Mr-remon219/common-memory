#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
rmSync(new URL('../dist/', import.meta.url), {recursive:true, force:true});
const result = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '-p', 'tsconfig.build.json'], {cwd:root, stdio:'inherit'});
if (result.error || result.status !== 0) { console.error(result.error?.message ?? 'Build compilation failed'); process.exit(result.status || 1); }
await import('./build-assets.mjs');
