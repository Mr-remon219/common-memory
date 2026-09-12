import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

it('the synthetic demo refuses a non-empty --home and never touches existing configuration or data', () => {
  const home = mkdtempSync(join(tmpdir(), 'cm-demo-guard-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'config.json'), '{"real":"config"}');
  mkdirSync(join(home, 'data/memory'), { recursive: true });
  writeFileSync(join(home, 'data/memory/profile.md'), '# Profile\n\n## Real\nkeep me\n');
  const result = spawnSync(process.execPath, [resolve('scripts/demo-init-synthetic.mjs'), '--home', home], { encoding: 'utf8', timeout: 30000 });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Refusing to reuse non-empty');
  expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe('{"real":"config"}');
  expect(readFileSync(join(home, 'data/memory/profile.md'), 'utf8')).toContain('keep me');
  expect(readdirSync(home).sort()).toEqual(['config.json', 'data']);
  expect(spawnSync(process.execPath, [resolve('scripts/demo-init-synthetic.mjs'), '--home', join(home, 'config.json')], { encoding: 'utf8', timeout: 30000 }).stderr).toContain('not a directory');
});

