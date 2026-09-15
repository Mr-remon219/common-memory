import { stubInstalledBuild } from '../helpers/installation-build.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'smol-toml';
import { installIntegrations } from '../../src/cli/integrations.js';
import { saveServiceControl, serviceName } from '../../src/service/control.js';
import { launcherPath } from '../../src/service/manager.js';
let root='';afterEach(()=>{vi.unstubAllEnvs();if(root)rmSync(root,{recursive:true,force:true});});
it('managed MCP/Hook entries stay stable and the Pi loader follows the activated Core target',async()=>{
 root=mkdtempSync(join(tmpdir(),'cm-stable-entry-'));const home=join(root,'home'),dataRoot=join(home,'data');vi.stubEnv('COMMON_MEMORY_HOME',home);stubInstalledBuild();
 writeFileSync(join(root,'package.json'),'{"type":"module"}');
 for(const version of ['one','two']){const directory=join(root,version,'dist/pi-extension');mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'index.js'),`export default api=>{api.loaded=${JSON.stringify(version)}};`);}
 const control={version:1 as const,enabled:true,dataRoot,node:process.execPath,cli:join(root,'one/dist/cli/main.js'),packageVersion:'test',manager:'systemd' as const,name:serviceName(home)};saveServiceControl(control,home);
 installIntegrations([{id:'pi',name:'Pi',root:join(root,'pi'),mode:'posix',hooks:false},{id:'codex',name:'Codex',root:join(root,'codex'),mode:'posix',hooks:true}],dataRoot,{home});
 const config=parse(readFileSync(join(root,'codex/config.toml'),'utf8')) as any;
 expect(config.mcp_servers.common_memory).toMatchObject({command:'/bin/sh',args:[launcherPath(home),'mcp','--client-id','common-memory-local','--capability','read','--global']});
 const hook=JSON.parse(readFileSync(join(root,'codex/hooks.json'),'utf8')).hooks.SessionStart[0].hooks[0].command;expect(hook).toContain(launcherPath(home));expect(hook).not.toContain('/one/');
 const wrapper=join(home,'integrations/pi/common-memory.js'),before=readFileSync(wrapper,'utf8');const module=await import(pathToFileURL(wrapper).href);const api:{loaded?:string}={};await module.default(api);expect(api.loaded).toBe('one');
 saveServiceControl({...control,cli:join(root,'two/dist/cli/main.js')},home);await module.default(api);expect(api.loaded).toBe('two');expect(readFileSync(wrapper,'utf8')).toBe(before);
});
