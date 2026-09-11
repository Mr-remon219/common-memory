import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, vi } from 'vitest';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const cli = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));

/**
 * Ownership/setup unit tests generate installation files but never execute dist.
 * Model only the installed CLI's presence; all destination IO remains real.
 * The post-build tarball consumer verifies the actual CLI and Pi wrapper load.
 */
export function stubInstalledBuild(available = true): void {
  vi.mocked(existsSync).mockImplementation(path => path === cli ? available : actual.existsSync(path));
}
afterEach(() => { vi.mocked(existsSync).mockImplementation(actual.existsSync); });
