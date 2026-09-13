import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Caller runs cleanup after closing its stores and subprocesses. */
export function tempRoots(prefix: string) {
  const roots: string[] = [];
  return {
    root() {
      const path = mkdtempSync(join(tmpdir(), prefix));
      roots.push(path);
      return path;
    },
    cleanup() {
      for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
    },
  };
}
