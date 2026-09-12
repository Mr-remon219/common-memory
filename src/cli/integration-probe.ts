import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { probeReadServer } from '../mcp/probe.js';
import { parse } from 'smol-toml';
import { integrationHealth, type InstallationState } from './integrations.js';
import { readInstallationFile } from './installation-files.js';
import type { IntegrationTarget } from './integration-targets.js';

export interface IntegrationProbe { ok: boolean; code: 'READ_TOOLS_READY' | 'FILES_CHANGED' | 'READ_MCP_FAILED' }

/** Probe only the owned read process: no memory bodies, init/Writer startup or model calls. */
export async function probeReadIntegration(state: InstallationState, target: IntegrationTarget, timeout = 10_000): Promise<IntegrationProbe> {
  if (target.id === 'pi' || !integrationHealth(state, target.id)) return { ok: false, code: 'FILES_CHANGED' };
  try {
    const path = join(target.root, 'config.toml');
    const owned = state.resources.find(r => r.path === path && r.kind === 'toml' && r.owners.includes(target.id)
      && Object.hasOwn(parse(r.content!).mcp_servers as object, 'common_memory'));
    if (!owned) return { ok: false, code: 'FILES_CHANGED' };
    const body = readInstallationFile(path);
    if (!body?.includes(owned.content!)) return { ok: false, code: 'FILES_CHANGED' };
    const server = (parse(owned.content!).mcp_servers as Record<string, any>).common_memory;
    const command = target.mode === 'windows-wsl'
      ? execFileSync('/usr/bin/wslpath', ['-u', server.command], { encoding: 'utf8', timeout: 3000 }).trim()
      : server.command;
    return await probeReadServer({ command, args: server.args, env: server.env }, timeout)
      ? { ok: true, code: 'READ_TOOLS_READY' } : { ok: false, code: 'READ_MCP_FAILED' };
  } catch {
    // Client stderr and arbitrary errors can contain environment values and credentials.
    return { ok: false, code: 'READ_MCP_FAILED' };
  }
}
