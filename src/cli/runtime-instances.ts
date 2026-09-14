import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readInstallationFile, writeInstallationFile } from './installation-files.js';
import { join } from 'node:path';
import { configDirectory } from '../config/config.js';
import { applicationRoot } from './integrations.js';

export type RuntimeRole = 'cli' | 'mcp' | 'pi' | 'drain' | 'unknown';
export interface RuntimeInstance {
  pid: number;
  role: RuntimeRole;
  version: string;
  started: string;
  executable: string;
  cli: string;
  status: 'loaded' | 'unregistered' | 'stale' | 'unknown';
}
interface RegisteredInstance extends Omit<RuntimeInstance, 'status'> {}
const instancesDirectory = (home: string) => join(home, '.installation', 'instances');
const packageVersion = (): string => {
  try { return (JSON.parse(readFileSync(join(applicationRoot, 'package.json'), 'utf8')) as { version?: unknown }).version as string ?? 'unknown'; }
  catch { return 'unknown'; }
};

/** Linux start time is stable across PID reuse. Other systems deliberately return unknown. */
export function processStartIdentity(pid: number, procRoot = '/proc', platform = process.platform): string | undefined {
  if (platform !== 'linux') return;
  try {
    const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).trim().split(/\s+/u);
    // Field 22 is starttime; fields begin at field 3 after the executable name.
    const boot=readFileSync(join(procRoot,'sys/kernel/random/boot_id'),'utf8').trim();
    return /^[a-f0-9-]{36}$/u.test(boot) && /^\d+$/u.test(fields[19] ?? '') ? `${boot}-${fields[19]}` : undefined;
  } catch { return; }
}

/** A small filesystem receipt proves only code that registered itself was actually loaded. */
export function registerRuntimeInstance(input: Omit<RegisteredInstance, 'started'> & { started?: string; home?: string; procRoot?: string; platform?: NodeJS.Platform }): () => void {
  const home = input.home ?? configDirectory();
  const started = input.started ?? processStartIdentity(input.pid, input.procRoot, input.platform) ?? 'unknown';
  const row: RegisteredInstance = { pid: input.pid, role: input.role, version: input.version, started, executable: input.executable, cli: input.cli };
  const directory = instancesDirectory(home), path = join(directory, `${row.pid}-${randomUUID()}.json`);
  const body=JSON.stringify(row)+'\n';
  try { writeInstallationFile(path,body); }
  catch { /* Observability must never prevent a host/MCP from starting. */ }
  return () => { try { if(readInstallationFile(path)===body)writeInstallationFile(path,null); } catch { /* No removal of changed/unowned files. */ } };
}
function readRegistered(home: string): RegisteredInstance[] {
  const directory = instancesDirectory(home);
  try {
    return readdirSync(directory).filter(name => /^\d+-[^/]+\.json$/u.test(name)).flatMap(name => {
      try {
        const value: unknown = JSON.parse(readInstallationFile(join(directory, name)) ?? 'null');
        if (!value || typeof value !== 'object') return [];
        const row = value as Record<string, unknown>;
        if (!Number.isSafeInteger(row.pid) || row.pid as number <= 0 || !['cli', 'mcp', 'pi', 'drain'].includes(String(row.role)) || typeof row.version !== 'string' || typeof row.started !== 'string' || typeof row.executable !== 'string' || typeof row.cli !== 'string') return [];
        return [row as unknown as RegisteredInstance];
      } catch { return []; }
    });
  } catch { return []; }
}
function processCommand(pid: number, procRoot: string): string[] | undefined {
  try {
    const bytes = readFileSync(join(procRoot, String(pid), 'cmdline'));
    if (bytes.length > 1_048_576) return;
    return bytes.toString('utf8').split('\0').filter(Boolean);
  } catch { return; }
}
function looksLikeCommonMemory(command: string[]): boolean {
  return command.some(value => /(?:^|[/\\])common-memory(?:\.js)?$/u.test(value) || /common-memory-core[/\\]dist[/\\]cli[/\\]main\.js$/u.test(value));
}
function cliFromCommand(command: string[]): string {
  return command.find(value => /common-memory(?:-core)?[/\\]dist[/\\](?:cli[/\\])?main\.js$/u.test(value)) ?? command.find(value => /common-memory/u.test(value)) ?? 'unknown';
}

/** Read-only Linux /proc inspection. It never signals, opens SQLite, or treats a match as a loaded version. */
export function listRuntimeInstances(options: { home?: string; procRoot?: string; platform?: NodeJS.Platform } = {}): RuntimeInstance[] {
  const home = options.home ?? configDirectory(), procRoot = options.procRoot ?? '/proc', platform = options.platform ?? process.platform;
  const registered = readRegistered(home), rows: RuntimeInstance[] = [], seen = new Set<number>();
  for (const row of registered) {
    const started = processStartIdentity(row.pid, procRoot, platform);
    if (started !== undefined && started === row.started) {
      rows.push({ ...row, status: 'loaded' }); seen.add(row.pid);
    } else rows.push({ ...row, status: started!==undefined || platform==='linux'&&!existsSync(join(procRoot,String(row.pid))) ? 'stale' : 'unknown' });
  }
  if (platform !== 'linux' || !existsSync(procRoot)) return rows.sort((a, b) => a.pid - b.pid);
  let entries: string[] = [];
  try { entries = readdirSync(procRoot); } catch { return rows.sort((a, b) => a.pid - b.pid); }
  for (const name of entries) {
    if (!/^\d+$/u.test(name)) continue;
    const pid = Number(name); if (seen.has(pid)) continue;
    const command = processCommand(pid, procRoot);
    if (!command || !looksLikeCommonMemory(command)) continue;
    rows.push({ pid, role: 'unknown', version: 'unknown', started: processStartIdentity(pid, procRoot, platform) ?? 'unknown', executable: command[0] ?? 'unknown', cli: cliFromCommand(command), status: 'unregistered' });
  }
  return rows.sort((a, b) => a.pid - b.pid);
}
export function runtimeInstanceLines(options: Parameters<typeof listRuntimeInstances>[0] = {}): string[] {
  const rows = listRuntimeInstances(options);
  if (!rows.length) return ['Loaded instances: none observed (not proof that a non-Linux or unregistered host is stopped)'];
  return rows.map(row => `Loaded instance: pid ${row.pid} · ${row.role} · ${row.version} · ${row.status} · ${row.cli}`);
}
const loadedPackageVersion = packageVersion();
export const currentRuntimeVersion = () => loadedPackageVersion;
