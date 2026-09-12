import { registerHooks } from 'node:module';
import '../../mcp/fixtures/source-loader.mjs';
import './no-sqlite.mjs';

// Use the real prompt renderer with deterministic terminal dimensions. Route stderr
// to the same display stream, just as both descriptors share a terminal in the CLI.
Object.defineProperty(process.stdin, 'isTTY', { value: true });
Object.defineProperties(process.stdout, {
  isTTY: { value: true }, columns: { value: 120 }, rows: { value: 40 },
});
process.stdin.setRawMode = raw => { process.stdin.isRaw = raw; return process.stdin; };
process.stderr.write = process.stdout.write.bind(process.stdout);

const entry = new URL('../../../src/cli/main.ts', import.meta.url);
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    if (url !== entry.href) return loaded;
    // SQLite emits a queued warning on some Node releases. Inject that timing on
    // every CI runtime, including newer Node 24 versions where SQLite is stable.
    const source = String(loaded.source).replace(/^#![^\n]*\n/u, '');
    return { ...loaded, source: `process.emitWarning('SYNTHETIC_STARTUP_WARNING', 'ExperimentalWarning');\n${source}` };
  },
});
await import(entry.href);
if (process.stdin.isRaw) throw new Error('Terminal raw mode was not restored');
