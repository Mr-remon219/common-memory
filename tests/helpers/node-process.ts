import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';

/** Own the child until close (including its stdio), even when the test times out. */
export function nodeProcess(args: string[], options: SpawnOptionsWithoutStdio & { timeoutMs?: number } = {}) {
  const { timeoutMs = 30_000, ...spawnOptions } = options;
  const child = spawn(process.execPath, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', failure: Error | undefined, closed = false;
  let resolveClosed!: () => void;
  const closing = new Promise<void>(resolve => { resolveClosed = resolve; });
  const stop = async () => {
    if (!closed && child.exitCode === null && child.signalCode === null) {
      failure ??= new Error('Test cleanup cancelled the Node child');
      child.kill('SIGKILL');
    }
    await closing;
  };
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => {
    failure = new Error(`Node child timed out after ${timeoutMs}ms`);
    void stop();
  }, timeoutMs);
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', error => { failure = error; });
    child.once('close', (code, signal) => {
      closed = true; clearTimeout(timer); resolveClosed();
      if (failure) reject(new Error(`${failure.message}\nexit=${code}, signal=${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`, { cause: failure }));
      else resolve({ code, signal, stdout, stderr });
    });
  });
  // Teardown can cancel a child after Vitest has already timed out its awaiting test.
  // Keep that rejection handled; awaiting result still reports the original failure.
  void result.catch(() => {});
  return { child, result, stop };
}
