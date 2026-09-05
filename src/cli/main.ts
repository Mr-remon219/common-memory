#!/usr/bin/env node
import { loadConfig } from "../config/config.js";
import { createConfiguredWriter } from "../config/runtime.js";
import { ProjectRegistry } from "../v2/registry.js";
import { withRepositoryLock } from "../v2/lock.js";
import { RuntimeStore } from "../v2/runtime.js";
import { printStatus, runSetupWizard, runTui, UserCancelled } from "./tui.js";

async function main(): Promise<void> {
  const [command,...args]=process.argv.slice(2);
  if(command==="--help" || command==="-h") {console.log("Common Memory V2\n\ncommon-memory [config|status|flush]\ncommon-memory project register <root> <name>\ncommon-memory project list\ncommon-memory project remove <id>\ncommon-memory retry <job-id>");return;}
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
