import { cpSync, mkdirSync } from "node:fs";
const destination = new URL('../dist/memory-agent-runtime/',import.meta.url);
mkdirSync(destination,{recursive:true});
cpSync(new URL('../src/memory-agent-runtime/system.md',import.meta.url),new URL('system.md',destination));
cpSync(new URL('../src/memory-agent-runtime/skills/',import.meta.url),new URL('skills/',destination),{recursive:true});
