import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { withRepositoryLock } from '../../src/v2/lock.js';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cm-lock-'));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('locks a fresh nested data root without relying on a registry read to create storage', () => {
  const dataRoot = join(fixture(), 'missing', 'data');
  expect(withRepositoryLock(dataRoot, () => 'locked')).toBe('locked');
  expect(existsSync(join(dataRoot, 'runtime', 'repository-lock.sqlite'))).toBe(true);
  expect(withRepositoryLock(dataRoot, () => 'reopened')).toBe('reopened');
});

it('rejects a linked ancestor before creating lock storage or running the action', () => {
  const root = fixture(), outside = join(root, 'outside'), link = join(root, 'link');
  mkdirSync(outside);
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  let called = false;
  expect(() => withRepositoryLock(join(link, 'data'), () => { called = true; })).toThrow('UNSAFE_PATH');
  expect(called).toBe(false);
  expect(existsSync(join(outside, 'data'))).toBe(false);
});
