import { defineConfig } from 'vitest/config';

// Native Windows owns only the host bridge. Core runs and is verified in POSIX.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/windows/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    maxWorkers: 1,
  },
});
