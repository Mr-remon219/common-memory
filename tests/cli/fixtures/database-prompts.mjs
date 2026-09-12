import '../../mcp/fixtures/source-loader.mjs';

Object.defineProperty(process.stdin, 'isTTY', { value: true });
Object.defineProperties(process.stdout, { isTTY: { value: true }, columns: { value: 120 }, rows: { value: 40 } });
process.stdin.setRawMode = raw => { process.stdin.isRaw = raw; return process.stdin; };
process.stderr.write = process.stdout.write.bind(process.stdout);

const prompts = await import('../../../src/cli/prompt-runtime.ts');
const { RuntimeStore } = await import('../../../src/v2/runtime.ts');
const { withRepositoryLock } = await import('../../../src/v2/lock.ts');
const { assertDeletableData } = await import('../../../src/cli/uninstall.ts');
const { defaultConfig } = await import('../../../src/config/config.ts');
const config = defaultConfig();
// Complete one prompt before loading SQLite, reproducing a first database operation
// during a TUI session rather than only at CLI startup.
await prompts.select({ message: 'PROMPT:initial', options: [{ value: 'ok', label: 'Continue' }] });
const operations = [
  ['select', () => { const store = new RuntimeStore(config.dataRoot); store.close(); }],
  ['multiselect', () => withRepositoryLock(config.dataRoot, () => {})],
  ['text', () => { try { withRepositoryLock(config.dataRoot, () => { throw new Error('synthetic'); }); } catch {} }],
  ['password', () => assertDeletableData(config)],
  ['confirm', () => { const store = new RuntimeStore(config.dataRoot); try { store.transaction(() => { throw new Error('synthetic'); }); } catch {} finally { store.close(); } }],
];
for (const [kind, operation] of operations) {
  operation();
  // Node 24 can have stable SQLite; exercise identical queued-warning timing there.
  process.emitWarning(`DATABASE_WARNING:${kind}`, 'ExperimentalWarning');
  const options = { message: `PROMPT:${kind}` };
  if (kind === 'select' || kind === 'multiselect') options.options = [{ value: 'ok', label: 'Continue' }];
  await prompts[kind](options);
}
if (process.stdin.isRaw) throw new Error('Terminal raw mode was not restored');
process.stdout.write('DATABASE_PROMPTS_DONE\n');
