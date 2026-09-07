#!/usr/bin/env node
import { join } from "node:path";
import { loadConfig } from "../config/config.js";
import { createConfiguredWriter } from "../config/runtime.js";
import { ProjectRegistry } from "../v2/registry.js";
import { withRepositoryLock } from "../v2/lock.js";
import { RuntimeStore } from "../v2/runtime.js";
import { printStatus, runSetupWizard, runTui, UserCancelled } from "./tui.js";

async function main(): Promise<void> {
  const [command,...args]=process.argv.slice(2);
  if(command==="--help" || command==="-h") {console.log("Common Memory V2\n\ncommon-memory [config|status|flush]\ncommon-memory show [--workspace <absolute-path>]\ncommon-memory import <file.md> [--workspace <absolute-path>] [--author user|agent|third_party|mixed|unknown] [--label <text>] [--no-wait]\ncommon-memory project register <root> <name>\ncommon-memory project list\ncommon-memory project remove <id>\ncommon-memory retry <job-id>\ncommon-memory mcp --client-id <id> [--capability relay|init|read]... [--workspace <absolute-path>]... [--global] [--accept-client-reported-user-turns]\ncommon-memory mcp-config [--wsl] [--distro <name>] [--user <name>] [--workspace <absolute-path>]...");return;}
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
    const {readAuthorizedMemory,renderMemoryView}=await import('../v2/reader.js');
    const contexts=["global"];
    if(args.length===2 && args[0]==="--workspace"){const project=new ProjectRegistry(config.dataRoot).resolve(args[1]!);if(!project)throw new Error("Workspace is not registered");contexts.push(`project:${project.id}`);}
    else if(args.length)throw new TypeError("Unknown command or unexpected arguments; use --help");
    const view=readAuthorizedMemory({dataRoot:config.dataRoot,contexts:contexts.filter(scope=>config.disclosure.allowedScopes.includes(scope))});
    console.log(`Memory files: ${join(config.dataRoot,"memory")}`);
    console.log(renderMemoryView(view));
    return;
  }
  if(command===undefined) {await runTui();return;}
  if(command==="config" && !args.length) {await runSetupWizard();return;}
  if(command==="status" && !args.length) {printStatus(); const config=loadConfig();if(config){const store=new RuntimeStore(config.dataRoot);try{console.log(JSON.stringify(store.status(),null,2));}finally{store.close();}}return;}
  const config=loadConfig();if(!config)throw new Error("Run common-memory config first");
  if(command==="flush" && !args.length) {const writer=createConfiguredWriter(config);try{writer.store.requestFlush();for(;;){const result=await writer.run({force:true});console.log(JSON.stringify(result));if(!["committed","noop","ignored","quarantined"].includes(result.outcome))break;}}finally{writer.close();}return;}
  if(command==="retry" && args.length===1){const store=new RuntimeStore(config.dataRoot);try{store.retry(args[0]!);store.requestFlush();}finally{store.close();}return;}
  if(command==="project") {
    const registry=new ProjectRegistry(config.dataRoot);const [action,...rest]=args;
    if(action==="list" && !rest.length){console.log(JSON.stringify(registry.list(),null,2));return;}
    if(action==="register" && rest.length===2){console.log(JSON.stringify(withRepositoryLock(config.dataRoot,()=>registry.register(rest[0]!,rest[1]!)),null,2));console.log("Registration does not grant remote disclosure or write permission; configure project:<id> in each allowed scope list.");return;}
    if(action==="remove" && rest.length===1){console.log(withRepositoryLock(config.dataRoot,()=>registry.remove(rest[0]!))?"Registration removed; Markdown retained":"Project not registered");return;}
  }
  throw new TypeError("Unknown command or unexpected arguments; use --help");
}
try {await main();}catch(error){if(error instanceof UserCancelled)process.exitCode=0;else{console.error(error instanceof Error?error.message:"Common Memory failed");process.exitCode=1;}}
