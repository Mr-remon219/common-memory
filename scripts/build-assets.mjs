import { cpSync, mkdirSync } from "node:fs";
mkdirSync(new URL('../dist/v2/',import.meta.url),{recursive:true});
cpSync(new URL('../src/v2/memory-maintainer.md',import.meta.url),new URL('../dist/v2/memory-maintainer.md',import.meta.url));
