import { spawn } from 'node:child_process';

/** Deliberate native-host handoff, never a shell string. Cancellation returns to the TUI. */
export function runInteractiveProcess(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env, shell: false });
    const interrupt = () => { child.kill('SIGINT'); };
    const terminate = () => { child.kill('SIGTERM'); };
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => { cleanup(); resolve(code ?? 1); });
  });
}
