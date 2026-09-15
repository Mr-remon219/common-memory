import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultConfig } from '../../src/config/config.js';
import { ServiceClient } from '../../src/service/client.js';
import { socketPath, loadServiceControl } from '../../src/service/control.js';
import { openDatabase } from '../../src/v2/sqlite.js';
import { toolProvider, sendTools } from '../helpers/tool-provider.js';
const cleanup:(()=>unknown|Promise<unknown>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function until(test:()=>boolean|Promise<boolean>,timeout=130000){const deadline=Date.now()+timeout;while(!await test()){if(Date.now()>deadline)throw new Error('NATIVE_TEST_TIMEOUT');await delay(100);}}
/** Opt-in: creates ONLY a uniquely named, temporary user-owned OS service. Build first. */
it.skipIf(process.env.CM_RUN_NATIVE_SERVICE_TESTS!=='1'||process.platform==='win32')('native supervisor restarts a killed Core and commits the original task once; remove prevents wake',async()=>{
 const manager=await import(pathToFileURL(resolve('dist/service/manager.js')).href) as typeof import('../../src/service/manager.js');
 const home=mkdtempSync(join(tmpdir(),'cm native-service-'));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));cleanup.push(()=>rmSync(dirname(socketPath(home)),{recursive:true,force:true}));
 let release=false,calls=0;const explore=toolProvider();
 const provider=createServer(async(req,res)=>{let text='';for await(const b of req)text+=b;calls++;await until(()=>release||res.destroyed);if(res.destroyed)return;const wire=JSON.parse(text),projection=explore(wire,res);if(!projection)return;sendTools(res,wire,[{name:'submit_memory_decision',args:{version:'memory_maintenance_v2',request_id:projection.request_id,decisions:[{kind:'retain',applicability:'global',admission:'remember',lifetime:'until_changed',confidence:1,evidence:projection.observations.map((o:{ref:string})=>o.ref),reason:'synthetic',operations:[{op:'put_section',target:'preferences',section:null,title:'Native service fixture',body:'Prefer concise replies.'}]}]}}]);});
 provider.listen(0,'127.0.0.1');await once(provider,'listening');cleanup.push(()=>{release=true;provider.closeAllConnections();return new Promise<void>(r=>provider.close(()=>r()));});
 const config=defaultConfig({COMMON_MEMORY_HOME:home});config.remote={provider:'openai-compatible',model:'fake',baseUrl:`http://127.0.0.1:${(provider.address() as {port:number}).port}/v1`,apiKeyEnv:'CM_TEST_KEY',proxy:{mode:'direct'}};config.scheduler.leaseMs=1000;
 writeFileSync(join(home,'config.json'),JSON.stringify(config));writeFileSync(join(home,'.env'),'CM_TEST_KEY="synthetic-key"\n',{mode:0o600});
 cleanup.push(()=>manager.stopService(home,true));
 let installed;try{installed=await manager.installService(config,home);}catch(error){try{console.error(readFileSync(join(home,'.service/core.log'),'utf8'));}catch{}if(process.env.WSL_DISTRO_NAME){const name=loadServiceControl(home)!.name;const ps=`[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$ProgressPreference='SilentlyContinue';$t=Get-ScheduledTask -TaskName '${name}';$i=$t|Get-ScheduledTaskInfo;@{state=$t.State.ToString();result=$i.LastTaskResult;last=$i.LastRunTime.ToString('o');execute=$t.Actions[0].Execute;arguments=$t.Actions[0].Arguments;executionTimeLimit=$t.Settings.ExecutionTimeLimit;restartInterval=$t.Settings.RestartInterval;restartCount=$t.Settings.RestartCount}|ConvertTo-Json -Depth 5 -Compress`;console.error(execFileSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],{encoding:'utf8'}));}throw error;}expect(installed.manager).toBe(process.env.WSL_DISTRO_NAME?'wsl-task':process.platform==='darwin'?'launchd':'systemd');
 const cli=new ServiceClient({kind:'cli'},home),mcp=new ServiceClient({kind:'mcp',options:{clientId:'native-fixture',global:true,accept:true,workspaces:[],capabilities:['relay']}},home);
 const identity={submissionId:'original-task',contextId:'global',text:'Please prefer concise replies.'};const accepted=await mcp.call<{taskId:string}>('mcp.submit',identity,{requestId:'native_request',wake:false});
 const first=await cli.call<{pid:number}>('service.status',{}, {wake:false});await until(()=>calls>0,15000);process.kill(first.pid,'SIGKILL');
 let second=first.pid;await until(async()=>{try{second=(await cli.call<{pid:number}>('service.status',{}, {wake:false,timeoutMs:500})).pid;return second!==first.pid;}catch{return false;}});
 expect(second).not.toBe(first.pid);expect(await mcp.call('mcp.submit',identity,{requestId:'native_request',wake:false})).toEqual(accepted);release=true;
 const state=()=>{const db=openDatabase(join(config.dataRoot,'runtime.sqlite'),{readOnly:true});try{return {receipts:db.prepare('SELECT * FROM receipts').all(),observations:db.prepare('SELECT id,jobId,state FROM observations').all(),jobs:db.prepare('SELECT id,retries,attempts FROM jobs').all()};}finally{db.close();}};
 await until(()=>state().receipts.length===1,20000);expect(readFileSync(join(config.dataRoot,'memory/preferences.md'),'utf8')).toContain('Prefer concise replies.');expect(readdirSync(join(config.dataRoot,'runtime/receipts'))).toHaveLength(1);expect(state().observations).toMatchObject([{id:Number(accepted.taskId.slice(5)),state:'processed'}]);expect(state().jobs).toMatchObject([{retries:1,attempts:2}]);
 await manager.stopService(home,true);expect(loadServiceControl(home)?.enabled).toBe(false);expect(()=>manager.wakeService(home)).toThrow('SERVICE_DISABLED');await expect(mcp.call('mcp.submit',{...identity,submissionId:'must-not-revive'},{wake:true})).rejects.toThrow('SERVICE_DISABLED');
 console.log(JSON.stringify({manager:installed.manager,taskId:accepted.taskId,firstPid:first.pid,restartedPid:second,observations:state().observations.length,receipts:state().receipts.length,jobs:state().jobs,disabled:true}));
},190000);
