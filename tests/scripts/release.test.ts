import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const { releaseIssues } = await import(pathToFileURL(resolve('scripts/check-release.mjs')).href);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cm-release-')); roots.push(root);
  // Synthetic metadata only: these fixtures do not choose this project's license.
  const manifest = { private: false, license: 'MIT', description: 'Synthetic package', homepage: 'https://example.test',
    repository: { url: 'https://example.test/repo' }, bugs: { url: 'https://example.test/issues' },
    publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' } };
  return { root, manifest };
}
it('blocks publication while private or without an owner-selected license and license file', () => {
  const { root, manifest } = fixture();
  const issues: string[] = releaseIssues({ ...manifest, private: true, license: undefined }, root);
  expect(issues).toHaveLength(3);
  expect(issues.join('\n')).toContain('owner');
  expect(issues.join('\n')).toContain('LICENSE is missing');
});
it('requires a nonempty license file and explicit public registry even with license metadata', () => {
  const { root, manifest } = fixture();
  writeFileSync(join(root, 'LICENSE'), ' \n');
  expect(releaseIssues(manifest, root)).toEqual([expect.stringContaining('LICENSE must contain')]);
  writeFileSync(join(root, 'LICENSE'), 'Synthetic fixture; no project rights are granted.');
  expect(releaseIssues(manifest, root)).toEqual([]);
  expect(releaseIssues({ ...manifest, license: 'UNLICENSED' }, root)).toEqual([expect.stringContaining('choose a distribution license')]);
  expect(releaseIssues({ ...manifest, publishConfig: {} }, root)).toEqual([expect.stringContaining('registry')]);
});
it('requires repository metadata and keeps the package lock identity aligned', () => {
  const { root, manifest } = fixture();
  writeFileSync(join(root, 'LICENSE'), 'Synthetic license fixture.');
  expect(releaseIssues({ ...manifest, repository: {}, description: '' }, root)).toHaveLength(2);
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(resolve('package-lock.json'), 'utf8'));
  expect(lock.name).toBe(pkg.name); expect(lock.version).toBe(pkg.version);
  expect(lock.packages[''].dependencies).toEqual(pkg.dependencies);
  expect(lock.packages[''].peerDependencies).toEqual(pkg.peerDependencies);
});
