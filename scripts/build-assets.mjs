import { cpSync, mkdirSync } from "node:fs";
mkdirSync(new URL('../dist/memory-agent-runtime/',import.meta.url),{recursive:true});
cpSync(new URL('../src/memory-agent-runtime/system.md',import.meta.url),new URL('../dist/memory-agent-runtime/system.md',import.meta.url));
