import { defineConfig } from "vitest/config";
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

// macOS /var is a system symlink. Fixtures use its real path so storage tests
// exercise the same no-symlink invariant as production, without weakening it.
if (process.platform === 'darwin') process.env.TMPDIR = realpathSync(tmpdir());

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/windows/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: "forks",
  }
});
