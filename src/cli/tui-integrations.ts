import * as clack from '@clack/prompts';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDirectory, loadConfig, type CommonMemoryConfig } from '../config/config.js';
import { listProjects } from './operations.js';
import { prepareHostBundle, writeHostBundle } from './work-config.js';
import { renderMcpConfig, type McpConfigOptions } from './mcp-config.js';
import { shellQuote } from './host-launch.js';
import { runInteractiveProcess } from './interactive-process.js';
import { checkConfigUnchanged, hasApiKey } from './tui-settings.js';
import { attempt, confirm, expandPath, menu, note, terminalText, text, unwrap, viewText } from './tui-prompts.js';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

export function integrationReadiness(config: CommonMemoryConfig): string {
  return [
    `Runtime: Node ${process.versions.node}; home: ${configDirectory()}`,
    `Store: ${config.dataRoot}`,
    `Read: no API key needed; scopes: ${config.disclosure.allowedScopes.join(', ')}`,
    `Capture: user_explicit ${config.disclosure.allowedProvenance.includes('user_explicit') ? 'authorized' : 'not authorized'}`,
    `Init: agent_observation ${config.disclosure.allowedProvenance.includes('agent_observation') ? 'authorized' : 'not authorized'}`,
    `Writer credential: ${hasApiKey(config) ? 'configured (not tested)' : 'missing'}`,
    `Writable scopes: ${config.writableScopes.join(', ') || '(none)'}`,
    'Host installation / enabled tools / hook trust: NOT VERIFIED by these local checks.',
    'Generated does not mean installed, trusted, connected, or successfully committed.',
  ].join('\n');
}

async function chooseWorkspaces(config: CommonMemoryConfig): Promise<string[]> {
  const projects = listProjects(config);
  if (!projects.length) return [];
  return unwrap(await clack.multiselect({ message: 'Optional registered project reads (global is included separately)', required: false,
    options: projects.map(p => ({ value: p.root, label: terminalText(p.name), hint: terminalText(`${p.root} · ${config.disclosure.allowedScopes.includes(`project:${p.id}`) ? 'disclosure allowed' : 'NOT authorized'}`) })), initialValues: [] }));
}

async function launchMode(): Promise<McpConfigOptions> {
  // A WSL terminal does not establish the agent's operating environment.
  const mode = await menu('Where does the agent process run?', [
    { value: 'posix', label: 'Same POSIX environment as Common Memory', hint: 'macOS or agent inside this WSL/Linux runtime' },
    { value: 'wsl', label: 'Native Windows agent → this WSL runtime', hint: 'Explicit distribution and Linux user; no Windows-native Core' },
  ]);
  if (mode === 'posix') return { wsl: false, workspaces: [] };
  return { wsl: true, distro: await text('WSL distribution', process.env.WSL_DISTRO_NAME ?? ''), user: await text('Linux user in that distribution'), workspaces: [] };
}

async function generateHost(config: CommonMemoryConfig, client: 'codex' | 'chatgpt-work'): Promise<void> {
  const options = await launchMode();
  options.workspaces = await chooseWorkspaces(config);
  const output = expandPath(await text('New bundle directory (must not already exist)'));
  const args = ['--mode', options.wsl ? 'windows-wsl' : 'posix', '--output', output, ...options.workspaces.flatMap(w => ['--workspace', w])];
  if (options.wsl) {
    args.push('--distro', options.distro!, '--user', options.user!);
    const bridge = await text('Absolute Windows destination of common-memory-bridge.ps1 (blank: translate output with wslpath)', '', true);
    if (bridge) args.push('--bridge-path', bridge);
  }
  const prepared = prepareHostBundle(config, args, client);
  await viewText(`${client} configuration preview`, prepared.bundle.config);
  await viewText('Explicit refresh skill preview', prepared.bundle.skill + '\n' + prepared.bundle.policy);
  if (prepared.bundle.bridge) await viewText('Windows bridge preview', prepared.bundle.bridge);
  if (!await confirm(`Write this reviewed bundle to ${output}? Host config and trust will NOT be changed.`)) return;
  checkConfigUnchanged(config);
  if (existsSync(output)) throw new Error('Choose a new bundle directory. Existing destinations are not changed by this wizard.');
  writeHostBundle(prepared.output, prepared.bundle);
  note([
    `Generated: ${output}`,
    '1. Inspect common-memory.config.toml and merge/install it in the ACTUAL agent configuration directory; keep Work and Codex profiles separate.',
    client === 'codex' ? '2. For Codex, use the common-memory profile: codex --profile common-memory.' : '2. Select the corresponding profile in the Work local agent environment (ordinary Chat is not covered).',
    '3. Install skills/memory-refresh in that agent’s skills directory. For Windows, place the bridge at the exact previewed Windows path.',
    '4. Review and trust commands through the host /hooks interface. No trust bypass was installed.',
    '5. Start a fresh host process. Review memory here and check Maintenance for actual session processing.',
    'Refresh stays inside the live host: /memory-refresh. The TUI cannot select an activation by cwd.',
    'Disable/remove: use host /hooks and its MCP settings, then remove only the config/skill entries you installed; canonical memory remains intact.',
    'Regenerate into a NEW directory after changing Node, installation path, home or workspace selection.',
  ].join('\n'), 'Generated — host activation still required');
}

async function generateMcp(config: CommonMemoryConfig): Promise<void> {
  const options = await launchMode();
  options.workspaces = await chooseWorkspaces(config);
  const body = renderMcpConfig(config, options);
  await viewText('MCP configuration preview (separate init/read processes)', body);
  if (await confirm('Export this configuration to a new file?')) {
    const output = expandPath(await text('New TOML file (parent directory must exist)'));
    checkConfigUnchanged(config);
    writeFileSync(output, body, { flag: 'wx', mode: 0o600 });
    clack.log.success(`Exported to ${terminalText(output)}; not installed in the host.`);
  }
  note('Merge only the desired blocks into the actual MCP host configuration. Read and Init stay separate; Codex should disable the Init server. Restart the host and inspect its tool list. Disable/remove through host MCP settings; do not delete the store. Relay remains an explicit trusted-host opt-in via the automation CLI, never enabled by these templates.', 'MCP activation / removal');
}

async function piIntegration(): Promise<void> {
  note(`Package: ${packageRoot}\nPi 0.84.4 extension; run Pi in the same POSIX/WSL environment.\nUse the same COMMON_MEMORY_HOME. Installation does not grant memory scopes.\nNative /memory-refresh and /memory-flush remain in the active Pi session.\nPi settings and trust remain owned by Pi; no Common Memory host-settings editor is added.`, 'Pi management');
  const action = await menu('Pi · official package manager', [
    { value: 'list', label: 'Inspect installed packages (pi list)' },
    { value: 'install', label: 'Register this local package for the current user' },
    { value: 'config', label: 'Enable / disable resources in Pi’s own UI' },
    { value: 'remove', label: 'Remove this package registration', hint: 'Does not remove Common Memory data' },
    { value: 'back', label: 'Back' },
  ]);
  if (action === 'back') return;
  if (action === 'install' && !existsSync(join(packageRoot, 'dist/pi-extension/index.js'))) throw new Error('Build the package before registering the Pi extension.');
  const args = ['install', 'remove'].includes(action) ? [action, packageRoot] : [action];
  note(`pi ${args.map(shellQuote).join(' ')}\nCOMMON_MEMORY_HOME=${configDirectory()}\nUses the pi executable on PATH. Install/remove use user settings; Pi may request its own project trust.`, 'Native host handoff');
  if (!await confirm('Run this Pi command?')) return;
  const code = await runInteractiveProcess('pi', args, { ...process.env, COMMON_MEMORY_HOME: configDirectory() });
  if (code !== 0) throw new Error(`Pi command failed or was cancelled (exit ${code}); host state was not verified.`);
  clack.log.success('Pi command finished. Restart Pi after changes; this does not prove a live capture or memory read.');
}

export async function integrationsScreen(): Promise<void> {
  for (;;) {
    const config = loadConfig();
    if (!config) throw new Error('Configure Common Memory first');
    const action = await menu('Common Memory / Integrations', [
      { value: 'readiness', label: 'Local readiness and authority' },
      { value: 'pi', label: 'Pi · manage extension via Pi' },
      { value: 'codex', label: 'Codex · generate session-hook + read bundle' },
      { value: 'work', label: 'ChatGPT Work · generate session + read/init bundle' },
      { value: 'mcp', label: 'MCP-only · preview/export stdio configurations' },
      { value: 'back', label: 'Back' },
    ]);
    if (action === 'back') return;
    await attempt(async () => {
      if (action === 'readiness') note(integrationReadiness(config), 'Local readiness — not host detection');
      else if (action === 'pi') await piIntegration();
      else {
        note(integrationReadiness(config), 'Integration prerequisites');
        if (action === 'mcp') await generateMcp(config);
        else await generateHost(config, action === 'codex' ? 'codex' : 'chatgpt-work');
      }
    });
  }
}
