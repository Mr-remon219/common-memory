import { spawn,type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { dirname,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';
import { loadConfig } from '../../src/config/config.js';
import { provisionServiceGrant,saveServiceControl,serviceName,socketPath } from '../../src/service/control.js';
import { ServiceClient } from '../../src/service/client.js';
import type { ChannelIdentity } from '../../src/service/protocol.js';
import { setTimeout as delay } from 'node:timers/promises';

const running=new Map<string,{child:ChildProcess,refs:number}>();
export type TestServiceStop=(()=>Promise<void>)&{child:ChildProcess};
const handle=(home:string,child:ChildProcess):TestServiceStop=>Object.assign(async()=>stopRef(home),{child});
/** Starts the real foreground daemon, without installing or invoking an OS manager. */
export async function startTestService(home:string,channels:ChannelIdentity[]=[]):Promise<TestServiceStop>{
  const existing=running.get(home);if(existing){existing.refs++;for(const channel of channels)provisionServiceGrant(channel,home);return handle(home,existing.child);}
  const config=loadConfig(resolve(home,'config.json'));if(!config)throw new Error('TEST_CONFIG_REQUIRED');
  saveServiceControl({version:1,enabled:true,dataRoot:config.dataRoot,node:process.execPath,cli:resolve('src/cli/main.ts'),packageVersion:'test',manager:'systemd',name:serviceName(home)},home);provisionServiceGrant({kind:'cli'},home);for(const channel of channels)provisionServiceGrant(channel,home);
  const loader=pathToFileURL(resolve('tests/mcp/fixtures/source-loader.mjs')).href,env={...process.env,COMMON_MEMORY_HOME:home,NODE_OPTIONS:`--import=${loader}`};
  const child=spawn(process.execPath,[resolve('src/cli/main.ts'),'service','run','--home',home],{env,stdio:['ignore','ignore','pipe']});let stderr='';child.stderr?.on('data',b=>stderr+=b);running.set(home,{child,refs:1});
  const client=new ServiceClient({kind:'cli'},home),deadline=Date.now()+10000;while(Date.now()<deadline){if(child.exitCode!==null)throw new Error(stderr||`service exited ${child.exitCode}`);try{await client.call('service.status',{}, {wake:false,timeoutMs:100});return handle(home,child);}catch{await delay(20);}}
  child.kill('SIGKILL');running.delete(home);throw new Error('TEST_SERVICE_TIMEOUT');
}
async function stopRef(home:string){const entry=running.get(home);if(!entry)return;if(--entry.refs>0)return;running.delete(home);try{await new ServiceClient({kind:'cli'},home).call('service.stop',{}, {wake:false,timeoutMs:1000});}catch{entry.child.kill('SIGTERM');}if(entry.child.exitCode===null&&entry.child.signalCode===null)await Promise.race([once(entry.child,'exit'),delay(2000).then(()=>entry.child.kill('SIGKILL'))]);rmSync(dirname(socketPath(home)),{recursive:true,force:true});}
