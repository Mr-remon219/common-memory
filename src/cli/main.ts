#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { loadConfig } from "../config/config.js";
import { runFlush } from "./flush-command.js";
import { listProjects, registerProject, removeProject, retryJob, runtimeStatus, showMemory } from './operations.js';
import { printStatus, runSetupWizard, runNetworkWizard, runTui, UserCancelled } from "./tui.js";

async function main(): Promise<void> {
  const [command,...args]=process.argv.slice(2);
  if ((command === '--version' || command === '-v') && !args.length) {
    console.log((JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version);
    return;
  }
  if(command==="--help" || command==="-h") {console.log("Common Memory V2\n\ncommon-memory                         Interactive workbench (TTY only)\n  Overview / Memory / Projects & permissions / Integrations / Maintenance / Settings\n\nScriptable commands and direct wizard shortcuts:\ncommon-memory [config|status|flush|session-drain]\ncommon-memory config --network\ncommon-memory network-test\ncommon-memory show [--workspace <absolute-path>]\ncommon-memory import <file.md> [--workspace <absolute-path>] [--author user|agent|third_party|mixed|unknown] [--label <text>] [--no-wait]\ncommon-memory project register <root> <name>\ncommon-memory project list\ncommon-memory project remove <id>\ncommon-memory retry <job-id>\ncommon-memory mcp --client-id <id> [--capability relay|init|read]... [--workspace <absolute-path>]... [--global] [--accept-client-reported-user-turns]\ncommon-memory codex-hook --home <absolute-path>\ncommon-memory codex-config [--mode posix|windows-wsl --output <new-directory>] [--workspace <absolute-path>]...\ncommon-memory work-hook --home <absolute-path>\ncommon-memory work-config --mode posix|windows-wsl --output <absolute-directory> [--distro <name>] [--user <name>] [--bridge-path <Windows-path>]\ncommon-memory session-refresh --home <absolute-path> [--client codex|chatgpt-work]\ncommon-memory mcp-config [--wsl] [--distro <name>] [--user <name>] [--workspace <absolute-path>]...");return;}
  if(command==='work-config'){(await import('./work-config.js')).runWorkConfig(args);return;}
  if(command==='work-hook'){await (await import('./codex-hook.js')).runCodexHook(args,'chatgpt-work');return;}
  if(command==='session-refresh'){(await import('./codex-hook.js')).runSessionRefresh(args);return;}
  if(command==="session-drain") {await (await import("./session-drain.js")).runSessionDrain(args);return;}
  if(command==="codex-hook") {await (await import('./codex-hook.js')).runCodexHook(args);return;}
  if(command==="codex-config") {
    if(args.length){(await import('./work-config.js')).runWorkConfig(args,'codex');return;}
    if(!loadConfig())throw new Error("Run common-memory config first");
    process.stdout.write((await import('./codex-config.js')).renderCodexConfig());return;
  }
  if(command==="mcp") {await (await import('../mcp/stdio.js')).runMcp(args);return;}
  if(command==="import") {
    const config=loadConfig();if(!config)throw new Error("Run common-memory config first");
    const {runImport}=await import('./import-command.js');
    const {exitCode}=await runImport(config,args);process.exitCode=exitCode;return;
  }
  if(command==="mcp-config") {
    const config=loadConfig();if(!config)throw new Error("Run common-memory config first");
    const {parseMcpConfigArgs,renderMcpConfig}=await import('./mcp-config.js');
    process.stdout.write(renderMcpConfig(config,parseMcpConfigArgs(args)));return;
  }
  if(command==="show") {
    // Same read path and authorization as MCP memory_read and the Pi extension: what consumers see.
    const config=loadConfig();if(!config)throw new Error("Run common-memory config first");
    if(args.length && !(args.length===2 && args[0]==="--workspace"))throw new TypeError("Unknown command or unexpected arguments; use --help");
    showMemory(config,args[1]);
    return;
  }
  if(command==="network-test" && !args.length) { const config=loadConfig();if(!config)throw new Error("Run common-memory config first");process.exitCode=await (await import("./network-test.js")).runNetworkTest(config);return; }
  if(command==="config" && args.length===1 && args[0]==="--network") {await runNetworkWizard();return;}
  if(command===undefined) {
    if(!process.stdin.isTTY || !process.stdout.isTTY) {console.log('Common Memory\n\nRun common-memory in an interactive terminal to open the workbench.\nUse common-memory --help for scriptable commands; no prompts were opened.');return;}
    await runTui();return;
  }
  if(command==="config" && !args.length) {await runSetupWizard();return;}
  if(command==="status" && !args.length) {printStatus();const config=loadConfig();if(config){const status=runtimeStatus(config);if(status)console.log(JSON.stringify(status,null,2));}return;}
  const config=loadConfig();if(!config)throw new Error("Run common-memory config first");
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
