import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { tempRoots } from '../helpers/temp-roots.js';
import { defaultConfig } from '../../src/config/config.js';
import { McpIngress } from '../../src/mcp/ingress.js';
import { readOutput } from '../../src/mcp/contract.js';
import { PiMemoryService } from '../../src/pi-extension/memory-service.js';
import { MEMORY_READ_DESCRIPTION, MEMORY_READ_REPLACEMENT_GUIDANCE } from '../../src/v2/read-guidance.js';

const roots=tempRoots('cm-read-guidance-');afterEach(()=>roots.cleanup());
it('on-demand MCP and Pi reads replace the same scope snapshot, including deletion, without polling or opening SQLite',()=>{
  const root=roots.root(),config=defaultConfig({COMMON_MEMORY_HOME:root});
  const mcp=new McpIngress(null,config,{clientId:'read-test',workspaces:[],global:true,accept:false,capabilities:['read']});
  const pi=new PiMemoryService({config:()=>config}),host={sessionId:'read-test',cwd:root};
  mkdirSync(join(config.dataRoot,'memory'),{recursive:true});const path=join(config.dataRoot,'memory/preferences.md');
  writeFileSync(path,'# Preferences\n\n## Style\nVersion A.\n');const snapshot=pi.read(host,'global');
  writeFileSync(path,'# Preferences\n\n## Style\nVersion B.\n');const latest=mcp.read('global');
  expect(snapshot.documents[1]!.content).toContain('Version A');expect(latest.documents[1]!.content).toContain('Version B');
  expect(latest.guidance).toBe(MEMORY_READ_REPLACEMENT_GUIDANCE);expect(MEMORY_READ_DESCRIPTION).toContain('replace older memory snapshots');
  expect(readOutput.parse(latest)).toEqual(latest);
  writeFileSync(path,'# Preferences\n');const empty=pi.read(host,'global');
  expect(empty.empty).toBe(true);expect(empty.guidance).toContain('including empty documents or removed content');expect(empty.guidance).toContain('Other scopes are unchanged');
  expect(latest.documents[1]!.content).toContain('Version B');
  expect(existsSync(join(config.dataRoot,'runtime.sqlite'))).toBe(false);
  config.disclosure.allowedScopes=[];expect(()=>pi.read(host,'global')).toThrow('CONTEXT_UNAVAILABLE');
});
