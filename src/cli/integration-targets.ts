import { execFileSync } from 'node:child_process';
import { constants, existsSync, accessSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

export type IntegrationId = 'codex' | 'chatgpt' | 'pi';
export interface IntegrationTarget {
  id: IntegrationId;
  name: string;
  root: string;
  mode: 'posix' | 'windows-wsl';
  hooks: boolean;
  hint?: string;
}
export interface DiscoveryEnvironment {
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  executable?: (name: string) => string | undefined;
  version?: (path: string) => string;
  windowsHome?: () => string | undefined;
}
function findExecutable(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const path = resolve(dir, name);
    try { accessSync(path, constants.X_OK); if (statSync(path).isFile()) return path; } catch { /* Not executable here. */ }
  }
  return undefined;
}
function nativeWindowsHome(): string | undefined {
  const powershell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  if (!existsSync(powershell)) return;
  // Fixed read-only script. Never inspect auth or chat history; never infer the agent mode from WSL.
  const command = '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); if(Get-AppxPackage -Name "*ChatGPT*"){[Console]::Write($env:USERPROFILE)}';
  try {
    const path = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!/^[A-Za-z]:\\/u.test(path)) return;
    return execFileSync('/usr/bin/wslpath', ['-u', path], { encoding: 'utf8', timeout: 3000 }).trim();
  } catch { return; }
}

/** Scan only at installation / Overview. Presence never means trusted or running. */
export function scanIntegrationTargets(options: DiscoveryEnvironment = {}): IntegrationTarget[] {
  const env = options.env ?? process.env, home = options.home ?? homedir(), platform = options.platform ?? process.platform;
  if (!['linux', 'darwin'].includes(platform)) return [];
  const executable = options.executable ?? (name => findExecutable(name, env));
  const version = options.version ?? (path => {
    try { return execFileSync(path, ['--version'], { env, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return ''; }
  });
  const targets: IntegrationTarget[] = [];
  const codex = executable('codex');
  if (codex) {
    const supported = /(?:^|\s)0\.153\.4(?:$|\s)/u.test(version(codex));
    targets.push({ id: 'codex', name: 'Codex CLI', root: resolve(env.CODEX_HOME || join(home, '.codex')), mode: 'posix', hooks: supported,
      hint: supported ? '读取 + 会话维护；Hooks 仍需宿主信任' : '读取接入；当前会话格式未验证' });
  }
  const desktop = platform === 'darwin' && [join('/Applications', 'ChatGPT.app'), join(home, 'Applications/ChatGPT.app')].some(existsSync)
    || Boolean(executable('chatgpt'));
  if (desktop) targets.push({ id: 'chatgpt', name: 'ChatGPT Desktop', root: resolve(env.CODEX_HOME || join(home, '.codex')), mode: 'posix', hooks: false, hint: '本地 Work / Codex 读取接入' });
  else if (platform === 'linux' && env.WSL_DISTRO_NAME) {
    const windows = (options.windowsHome ?? nativeWindowsHome)();
    if (windows) targets.push({ id: 'chatgpt', name: 'ChatGPT Desktop', root: join(windows, '.codex'), mode: 'windows-wsl', hooks: false, hint: 'Windows 本地 Work 读取接入' });
  }
  const pi = executable('pi');
  if (pi) {
    const supported = /(?:^|\s)0\.84\.4(?:$|\s)/u.test(version(pi));
    // Do not install an extension into an unverified host API version.
    if (supported) targets.push({ id: 'pi', name: 'Pi', root: resolve(env.PI_CODING_AGENT_DIR || join(home, '.pi/agent')), mode: 'posix', hooks: true });
  }
  return targets;
}
