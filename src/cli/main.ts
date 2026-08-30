#!/usr/bin/env node
import { printStatus, runSetupWizard, runTui, UserCancelled } from "./tui.js";

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (rest.length > 0) throw new TypeError("Unexpected arguments");
  switch (command) {
    case undefined: await runTui(); break;
    case "config": await runSetupWizard(); break;
    case "status": printStatus(); break;
    case "--help":
    case "-h": printHelp(); break;
    default: throw new TypeError(`Unknown command: ${command}`);
  }
}

function printHelp(): void {
  console.log(`Common Memory\n\nUsage:\n  common-memory          Open the TUI\n  common-memory config   Configure the remote API\n  common-memory status   Print configuration status\n  common-memory --help   Show this help`);
}

try { await main(); }
catch (error) {
  if (error instanceof UserCancelled) process.exitCode = 0;
  else { console.error(error instanceof Error ? error.message : "Common Memory failed"); process.exitCode = 1; }
}
