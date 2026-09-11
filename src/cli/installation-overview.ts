import { constants } from 'node:fs';
import { access, lstat, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDirectory, type CommonMemoryConfig } from '../config/config.js';
import { providerFor } from '../config/providers.js';
import { integrationHealth, readInstallationState } from './integrations.js';
import type { IntegrationId } from './integration-targets.js';

export interface ClientPresence { name: string; detected: boolean; connection: 'unverified' }

/** Discovery is not installation, authentication, hook trust, or a live connection check. */
export async function discoverClients(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  applications?: string[];
} = {}): Promise<ClientPresence[]> {
  const env = options.env ?? process.env, platform = options.platform ?? process.platform;
  const executable = async (name: string): Promise<boolean> => {
    for (const directory of (env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean)) {
      for (const suffix of platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['']) {
        const path = join(directory, name + suffix);
        try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) return true; }
        catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
      }
    }
    return false;
  };
  let desktop = false;
  // WSL does not establish where a Windows desktop agent executes. Do not guess its config path.
  if (platform === 'darwin') for (const directory of options.applications ?? ['/Applications', join(homedir(), 'Applications')]) {
    try { desktop ||= (await lstat(join(directory, 'ChatGPT.app'))).isDirectory(); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
  return [
    { name: 'Codex CLI', detected: await executable('codex'), connection: 'unverified' },
    { name: 'ChatGPT Desktop', detected: desktop, connection: 'unverified' },
    { name: 'Pi', detected: await executable('pi'), connection: 'unverified' },
  ];
}

/** Logical file sizes, never follow links or open SQLite. Missing storage remains absent. */
export async function storageBytes(path: string): Promise<number> {
  let stat;
  try { stat = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  if (stat.isSymbolicLink()) throw new Error('存储中有符号链接，未统计大小。');
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let bytes = 0;
  for (const name of await readdir(path)) bytes += await storageBytes(join(path, name));
  return bytes;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export async function installationOverview(config: CommonMemoryConfig): Promise<string> {
  let size: string;
  try { size = `${formatBytes(await storageBytes(config.dataRoot))}（记忆与运行数据）`; }
  catch { size = '无法完整统计'; }
  const state = readInstallationState();
  const clients: { id: IntegrationId; name: string }[] = [{ id: 'codex', name: 'Codex CLI' }, { id: 'chatgpt', name: 'ChatGPT Desktop' }, { id: 'pi', name: 'Pi' }];
  return [
    'Status        已配置 · 按需运行',
    `Application   ${fileURLToPath(new URL('../../', import.meta.url))}`,
    `Config        ${configDirectory()}`,
    `Memory        ${join(config.dataRoot, 'memory')}`,
    `Size          ${size}`,
    `Provider      ${providerFor(config.remote.baseUrl, config.remote.preset).name}`,
    `Model         ${config.remote.model}`,
    '', 'Integrations',
    ...clients.map(client => {
      const installed = state?.targets.find(t => t.id === client.id);
      if (!installed) return `○ ${client.name} · 未由此安装器接入`;
      if (!integrationHealth(state!, client.id)) return `! ${client.name} · 接入文件缺失或已变更`;
      return `✓ ${client.name} · 已安装${client.id === 'codex' && installed.hooks ? '（Hooks 信任由宿主确认）' : client.id !== 'pi' ? '（读取）' : ''}`;
    }),
  ].join('\n');
}
