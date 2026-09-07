import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configDirectory, type CommonMemoryConfig } from "../config/config.js";
import { ProjectRegistry } from "../v2/registry.js";

export interface McpConfigOptions { wsl: boolean; distro?: string | undefined; user?: string | undefined; workspaces: string[] }

export function parseMcpConfigArgs(args: string[]): McpConfigOptions {
  const options: McpConfigOptions = { wsl: false, workspaces: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--wsl") options.wsl = true;
    else if (arg === "--distro" || arg === "--user" || arg === "--workspace") {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) throw new TypeError(`${arg} requires a value`);
      if (arg === "--distro") options.distro = value; else if (arg === "--user") options.user = value;
      else { if (!isAbsolute(value)) throw new TypeError("--workspace must be an absolute path"); options.workspaces.push(value); }
    } else throw new TypeError(`Unknown mcp-config option ${arg}`);
  }
  return options;
}

const toml = (value: string) => JSON.stringify(value);
const list = (values: string[]) => `[${values.map(toml).join(", ")}]`;

/**
 * Print `config.toml` blocks for the Codex host (ChatGPT desktop init-only; Codex CLI read-only) that
 * pin the exact runtime this process is using: node binary, built CLI entry, configuration directory
 * and dataRoot. With `--wsl` the blocks are for a Windows host bridging into this WSL distribution
 * and user through `wsl.exe`, so every host reads the one store this configuration owns.
 */
export function renderMcpConfig(config: CommonMemoryConfig, options: McpConfigOptions, env: NodeJS.ProcessEnv = process.env): string {
  const node = realpathSync(process.execPath);
  // The entry the user actually ran (normally dist/cli/main.js), not a guessed install location.
  const cli = realpathSync(process.argv[1] ?? fileURLToPath(new URL("./main.js", import.meta.url)));
  const home = configDirectory(env);
  const registry = new ProjectRegistry(config.dataRoot);
  const workspaces = options.workspaces.map(workspace => {
    let project; try { project = registry.resolve(workspace); } catch { project = undefined; }
    if (!project) throw new Error(`UNREGISTERED_WORKSPACE: ${workspace}`);
    return { workspace: resolve(workspace), contextId: `project:${project.id}`, allowed: config.disclosure.allowedScopes.includes(`project:${project.id}`) };
  });
  const distro = options.distro ?? env.WSL_DISTRO_NAME;
  const user = options.user ?? userInfo().username;
  if (options.wsl && !distro) throw new Error("--wsl needs a distribution: run inside WSL or pass --distro <name>");
  const launch = (clientId: string, capability: string, extra: string[]) => {
    const inner = [cli, "mcp", "--client-id", clientId, "--capability", capability, "--global", ...extra];
    if (!options.wsl) return `command = ${toml(node)}\nargs = ${list(inner)}\nenv = { COMMON_MEMORY_HOME = ${toml(home)} }`;
    // No login shell runs under `wsl.exe -e`, so PATH and shell profiles are unavailable: absolute paths only.
    return `command = "wsl.exe"\nargs = ${list(["-d", distro!, "-u", user, "-e", "/usr/bin/env", `COMMON_MEMORY_HOME=${home}`, node, ...inner])}`;
  };
  const lines = [
    `# Common Memory MCP configuration for the Codex host (ChatGPT desktop app, Codex CLI, IDE extension).`,
    `# Generated ${new Date().toISOString()} by the runtime that owns this store; do not mix with another install.`,
    `#   ${options.wsl ? `WSL distribution: ${distro}; Linux user: ${user}` : `Host: ${process.platform}`}`,
    `#   Configuration directory (COMMON_MEMORY_HOME): ${home}`,
    `#   dataRoot (canonical Markdown under <dataRoot>/memory): ${config.dataRoot}`,
    `#   node: ${node}`,
    `#   CLI entry: ${cli}`,
    `# Every process below shares this one configuration authority and data; none of them is a resident service.`,
    ...(options.wsl ? [`# Pi is supported when it runs inside the same WSL distribution; Windows-native Pi is not covered by this configuration.`] : []),
    ``,
    `# ChatGPT desktop app (Codex or Work-local mode): Init only. The host prompts before non-read-only tools.`,
    `[mcp_servers.common_memory_init]`,
    launch("chatgpt-desktop", "init", []),
    `default_tools_approval_mode = "approve"`,
    ``,
    `# Codex CLI: read only. The process registers only memory_read/memory_status; enabled_tools repeats that host-side.`,
    `[mcp_servers.common_memory]`,
    launch("codex-cli", "read", workspaces.flatMap(w => ["--workspace", w.workspace])),
    `enabled_tools = ["memory_read", "memory_status"]`,
    `default_tools_approval_mode = "auto"`,
  ];
  for (const w of workspaces) if (!w.allowed) lines.push(`# NOTE: ${w.contextId} (${w.workspace}) is registered but not in disclosure.allowedScopes; it will not be readable until authorized.`);
  if (!config.disclosure.allowedScopes.includes("global")) lines.push(`# NOTE: "global" is not in disclosure.allowedScopes; both processes above have no readable/importable global context until authorized.`);
  if (!config.disclosure.allowedProvenance.includes("agent_observation")) lines.push(`# NOTE: disclosure.allowedProvenance lacks "agent_observation"; memory_init will answer INIT_DISABLED until common-memory config allows "Agent-reported understanding".`);
  if (options.wsl) lines.push(``, `# Workspace paths above are WSL paths. A Windows path (C:\\...) is not a registered project; register the WSL path instead.`);
  lines.push(``, `# Keep Codex CLI from seeing the init server: ~/.codex/memory-reader.config.toml with`, `#   [mcp_servers.common_memory_init]`, `#   enabled = false`, `# and run: codex --profile memory-reader`);
  return lines.join("\n") + "\n";
}
