#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { loadConfig } from "../config/config.js";
import { runFlush } from "./flush-command.js";
import { listProjects, registerProject, removeProject, retryJob, runtimeStatus, showMemory } from './operations.js';
import { printStatus, runNetworkWizard, runShowTui, runTui, UserCancelled } from "./tui.js";

async function main(): Promise<void> {
  // Imports can queue Node warnings (notably SQLite). Let them reach the terminal
  // before the first prompt: later output would displace Clack's redraw cursor.
  await setImmediate();
  const [command,...args]=process.argv.slice(2);
  if ((command === '--version' || command === '-v') && !args.length) {
    console.log((JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version);
    return;
  }
  if(command==='--help' || command==='-h') {
    console.log(`Common Memory

common-memory              Open Common Memory

First launch: Model Configuration → Agent Integration → Done
Later launches: Agent Integration / Memory Control / Model & Configuration

↑↓ Navigate · Enter Select · Esc Back
Space toggles Agents; Enter applies the selected installation state.

Compatibility / automation shortcuts:
common-memory show         Open the same TUI (plain output outside a terminal)
common-memory config       Reopen Model Configuration
common-memory uninstall    Remove integrations / remove application
common-memory show --plain  Plain authorized memory output
common-memory --version    Installed version

Existing automation and protocol commands remain supported; see docs/usage.md.`);
    return;
  }
  if(command==='uninstall' && !args.length){await (await import('./uninstall-tui.js')).runUninstallTui();return;}
  if(command==='work-config'){(await import('./work-config.js')).runWorkConfig(args);return;}
  if(command==='work-hook'){await (await import('./codex-hook.js')).runCodexHook(args,'chatgpt-work');return;}
  if(command==='session-refresh'){(await import('./codex-hook.js')).runSessionRefresh(args);return;}
  if(command==="session-drain") {await (await import("./session-drain.js")).runSessionDrain(args);return;}
  if(command==="codex-hook") {await (await import('./codex-hook.js')).runCodexHook(args);return;}
  if(command==="codex-config") {
    if(args.length){(await import('./work-config.js')).runWorkConfig(args,'codex');return;}
    if(!loadConfig())throw new Error("Run common-memory first");
    process.stdout.write((await import('./codex-config.js')).renderCodexConfig());return;
  }
  if(command==="mcp") {await (await import('../mcp/stdio.js')).runMcp(args);return;}
  if(command==="import") {
    const config=loadConfig();if(!config)throw new Error("Run common-memory first");
    const {runImport}=await import('./import-command.js');
    const {exitCode}=await runImport(config,args);process.exitCode=exitCode;return;
  }
  if(command==="mcp-config") {
    const config=loadConfig();if(!config)throw new Error("Run common-memory first");
    const {parseMcpConfigArgs,renderMcpConfig}=await import('./mcp-config.js');
    process.stdout.write(renderMcpConfig(config,parseMcpConfigArgs(args)));return;
  }
  if(command==="show") {
    // TTY management and plain automation share consumer read authorization.
    const config=loadConfig();if(!config)throw new Error("Run common-memory first");
    if(args.length && !(args.length===1 && args[0]==='--plain') && !(args.length===2 && args[0]==="--workspace"))throw new TypeError("Unknown command or unexpected arguments; use --help");
    if(!args.length && process.stdin.isTTY && process.stdout.isTTY) await runShowTui();
    else showMemory(config,args[0]==='--workspace' ? args[1] : undefined);
    return;
  }
  if(command==="network-test" && !args.length) { const config=loadConfig();if(!config)throw new Error("Run common-memory first");process.exitCode=await (await import("./network-test.js")).runNetworkTest(config);return; }
  if(command==="config" && args.length===1 && args[0]==="--network") {await runNetworkWizard();return;}
  if(command===undefined) {
    if(!process.stdin.isTTY || !process.stdout.isTTY) {console.log('Common Memory\n\nRun common-memory in an interactive terminal for setup, Agent Integration, Memory Control, and Model & Configuration.\nUse common-memory --help for scriptable commands; no prompts were opened.');return;}
    await runTui();return;
  }
  if(command==="config" && !args.length) {await (await import('./model-configuration.js')).configureModel();return;}
  if(command==="status" && !args.length) {printStatus();const config=loadConfig();if(config){const status=runtimeStatus(config);if(status)console.log(JSON.stringify(status,null,2));}return;}
  const config=loadConfig();if(!config)throw new Error("Run common-memory first");
  if(command==="flush" && !args.length) {process.exitCode=await runFlush(config);return;}
  if(command==="retry" && args.length===1){retryJob(config,args[0]!);return;}
  if(command==="project") {
    const [action,...rest]=args;
    if(action==="list" && !rest.length){console.log(JSON.stringify(listProjects(config),null,2));return;}
    if(action==="register" && rest.length===2){console.log(JSON.stringify(registerProject(config,rest[0]!,rest[1]!),null,2));console.log("Registration does not grant remote disclosure or write permission; configure project:<id> in each allowed scope list.");return;}
    if(action==="remove" && rest.length===1){console.log(removeProject(config,rest[0]!)?"Registration removed; Markdown retained":"Project not registered");return;}
  }
  throw new TypeError("Unknown command or unexpected arguments; use --help");
}
try {await main();}catch(error){if(error instanceof UserCancelled)process.exitCode=0;else{console.error(error instanceof Error?error.message:"Common Memory failed");process.exitCode=1;}}
