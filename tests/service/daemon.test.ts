import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultConfig } from '../../src/config/config.js';
import { saveServiceControl, provisionServiceGrant, serviceName, socketPath } from '../../src/service/control.js';
import { ServiceClient } from '../../src/service/client.js';
import { openDatabase } from '../../src/v2/sqlite.js';
import { toolProvider, sendTools } from '../helpers/tool-provider.js';
const cleanup:(()=>unknown|Promise<unknown>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function until(test:()=>boolean|Promise<boolean>){const end=Date.now()+12000;while(!await test()){if(Date.now()>end)throw new Error('TEST_TIMEOUT');await delay(25);}}
async function fixture(){
 const home=mkdtempSync(join(tmpdir(),'cm-service-'));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));cleanup.push(()=>rmSync(dirname(socketPath(home)),{recursive:true,force:true}));
 let release=false,calls=0;const explore=toolProvider();
 const provider=createServer(async(req,res)=>{let text='';for await(const b of req)text+=b;calls++;await until(()=>release||res.destroyed);if(res.destroyed)return;const wire=JSON.parse(text),projection=explore(wire,res);if(!projection)return;sendTools(res,wire,[{name:'submit_memory_decision',args:{version:'memory_maintenance_v2',request_id:projection.request_id,decisions:[{kind:'retain',applicability:'global',admission:'remember',lifetime:'until_changed',confidence:1,evidence:projection.observations.map((o:{ref:string})=>o.ref),reason:'synthetic',operations:[{op:'put_section',target:'preferences',section:null,title:'Synthetic service preference',body:'Prefer concise replies.'}]}]}}]);});
 provider.listen(0,'127.0.0.1');await once(provider,'listening');cleanup.push(()=>{release=true;provider.closeAllConnections();return new Promise<void>(r=>provider.close(()=>r()));});
 const config=defaultConfig({COMMON_MEMORY_HOME:home});config.remote={provider:'openai-compatible',model:'fake',baseUrl:`http://127.0.0.1:${(provider.address() as {port:number}).port}/v1`,apiKeyEnv:'CM_TEST_KEY',proxy:{mode:'direct'}};config.scheduler.leaseMs=300;
 writeFileSync(join(home,'config.json'),JSON.stringify(config));writeFileSync(join(home,'.env'),'CM_TEST_KEY="synthetic-key"\n',{mode:0o600});
 saveServiceControl({version:1,enabled:true,dataRoot:config.dataRoot,node:process.execPath,cli:resolve('src/cli/main.ts'),packageVersion:'0.4.2-test',manager:'systemd',name:serviceName(home)},home);provisionServiceGrant({kind:'cli'},home);
 const env={...process.env,COMMON_MEMORY_HOME:home,NODE_OPTIONS:`--import=${pathToFileURL(resolve('tests/mcp/fixtures/source-loader.mjs')).href}`};
 const cli=new ServiceClient({kind:'cli'},home),channel={kind:'mcp' as const,options:{clientId:'synthetic',workspaces:[],global:true,accept:true,capabilities:['relay' as const]}};const mcp=new ServiceClient(channel,home);
 const start=async()=>{const child=spawn(process.execPath,[resolve('src/cli/main.ts'),'service','run','--home',home],{env,stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);cleanup.push(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}});await until(async()=>{if(child.exitCode!==null)throw new Error(stderr);try{await cli.call('service.status',{}, {wake:false,timeoutMs:100});return true;}catch{return false;}});return child;};
 const state=()=>{const db=openDatabase(join(config.dataRoot,'runtime.sqlite'),{readOnly:true});try{return {jobs:db.prepare('SELECT id,state,attempts,retries,modelTurns,toolCalls FROM jobs').all(),observations:db.prepare('SELECT id,state,jobId,issue FROM observations').all(),receipts:db.prepare('SELECT * FROM receipts').all(),requests:db.prepare('SELECT * FROM service_requests').all()};}finally{db.close();}};
 return {home,config,env,channel,cli,mcp,start,state,release:()=>{release=true;},calls:()=>calls};
}
it.skipIf(process.platform==='win32')('durable IPC acceptance survives submitting process exit and request replay; exactly one actual commit',async()=>{
 const f=await fixture();await f.start();
 const body={submissionId:'one',contextId:'global',text:'Please prefer concise replies.'};
 const script=join(f.home,'channel.mjs');writeFileSync(script,`import {ServiceClient} from ${JSON.stringify(pathToFileURL(resolve('src/service/client.ts')).href)};const ack=await new ServiceClient(${JSON.stringify(f.channel)},${JSON.stringify(f.home)}).call('mcp.submit',${JSON.stringify(body)},{requestId:'stable_request',wake:false});console.log(JSON.stringify(ack));`);
 const host=spawn(process.execPath,[script],{env:f.env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';host.stdout.on('data',b=>stdout+=b);host.stderr.on('data',b=>stderr+=b);expect((await once(host,'exit'))[0],stderr).toBe(0);const accepted=JSON.parse(stdout);
 expect(accepted).toMatchObject({accepted:true,taskId:'task_1'});expect(f.state().observations).toHaveLength(1);expect(await f.mcp.call('mcp.submit',body,{requestId:'stable_request',wake:false})).toEqual(accepted);
 await expect(f.mcp.call('mcp.submit',{...body,text:'Different source'},{requestId:'stable_request',wake:false})).rejects.toThrow('SUBMISSION_CONFLICT');
 await until(()=>f.calls()>0);f.release();await until(()=>f.state().receipts.length===1);
 expect(readFileSync(join(f.config.dataRoot,'memory/preferences.md'),'utf8')).toContain('Prefer concise replies.');expect(readdirSync(join(f.config.dataRoot,'runtime/receipts'))).toHaveLength(1);expect(f.state().observations).toMatchObject([{id:1,state:'processed'}]);
 expect(f.state().requests).toHaveLength(1);expect(JSON.stringify(f.state().requests)).not.toContain(body.text);
},20000);
it.skipIf(process.platform==='win32')('planned service handoff fences the task without spending recovery budget; cancellation never revives',async()=>{
 const f=await fixture(),child=await f.start();provisionServiceGrant(f.channel,f.home);const body={submissionId:'handoff',contextId:'global',text:'Please prefer concise replies.'};
 const ack=await f.mcp.call<{taskId:string}>('mcp.submit',body,{requestId:'handoff_request',wake:false});await until(()=>f.calls()>0);const before=f.state().jobs[0]!;
 child.kill('SIGTERM');expect((await once(child,'exit'))[0]).toBe(0);expect(f.state().jobs[0]).toMatchObject({id:before.id,state:'retry',retries:before.retries,modelTurns:before.modelTurns,toolCalls:before.toolCalls});
 await f.start();await until(()=>f.state().jobs[0]?.state==='running');expect(await f.cli.call('task.cancel',{id:ack.taskId},{wake:false})).toMatchObject({cancelled:true});
 f.release();await delay(500);expect(f.state().observations[0]).toMatchObject({state:'paused',issue:'CANCELLED'});expect(f.state().receipts).toHaveLength(0);expect(existsSync(join(f.config.dataRoot,'memory/preferences.md'))).toBe(false);
},20000);
