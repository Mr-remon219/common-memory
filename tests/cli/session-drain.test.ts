import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { afterEach,expect,it } from 'vitest';
import { defaultConfig } from '../../src/config/config.js';
import { RuntimeStore } from '../../src/v2/runtime.js';
import { SessionIngress } from '../../src/v2/session.js';
const cleanup:(()=>unknown|Promise<unknown>)[]=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
async function until(f:()=>boolean){const end=Date.now()+15000;while(!f()){if(Date.now()>end)throw new Error('TIMED_OUT');await pause(50);}}
it.skipIf(process.platform!=='linux').each([false,true])('detached configured Writer finishes after host and MCP exit; crash recovery=%s',async crash=>{
 const home=mkdtempSync(join(tmpdir(),'cm-detached-'));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 let release=false,calls=0;
 const server=createServer(async(req,res)=>{
   let text='';for await(const b of req)text+=b;calls++;const projection=JSON.parse(JSON.parse(text).input[1].content[0].text);
   await until(()=>release||res.destroyed);if(res.destroyed)return;
   const decision={version:'memory_maintenance_v2',request_id:projection.request_id,decisions:[{kind:'retain',applicability:'global',admission:'remember',lifetime:'until_changed',confidence:1,evidence:projection.observations.map((o:{ref:string})=>o.ref),reason:'synthetic',operations:[{op:'put_section',target:'preferences',section:null,title:'Synthetic preference',body:'Prefer concise replies.'}]}]};
   res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'completed',incomplete_details:null,error:null,output:[{type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:JSON.stringify(decision),annotations:[]}]}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}));
 });server.listen(0,'127.0.0.1');await once(server,'listening');cleanup.push(()=>{release=true;server.closeAllConnections();return new Promise<void>(r=>server.close(()=>r()));});
 const config=defaultConfig({COMMON_MEMORY_HOME:home});config.remote={provider:'openai-compatible',model:'fake',baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,apiKeyEnv:'CM_TEST_KEY',proxy:{mode:'direct'}};config.scheduler.leaseMs=300;writeFileSync(join(home,'config.json'),JSON.stringify(config));
 const loader=pathToFileURL(resolve('tests/mcp/fixtures/source-loader.mjs')).href;
 const env={...process.env,COMMON_MEMORY_HOME:home,CM_TEST_KEY:'synthetic-key',NODE_OPTIONS:`--import=${loader}`};
 const script=join(home,'host.mjs');writeFileSync(script,`import {RuntimeStore} from ${JSON.stringify(pathToFileURL(resolve('src/v2/runtime.ts')).href)};import {SessionIngress} from ${JSON.stringify(pathToFileURL(resolve('src/v2/session.ts')).href)};import {launchSessionDrain} from ${JSON.stringify(pathToFileURL(resolve('src/cli/session-drain.ts')).href)};import {writeFileSync} from 'node:fs';const store=new RuntimeStore(${JSON.stringify(config.dataRoot)});const ingress=new SessionIngress(store);const key=ingress.open({client:'pi',processInstance:'synthetic-host',sessionId:'s'});ingress.capture(key,{id:'u',turnId:'t',role:'user',text:'Please prefer concise replies.',scope:'global',source:'interactive',observedAt:new Date().toISOString()});ingress.settle(key,'t');ingress.end(key);store.close();writeFileSync(${JSON.stringify(join(home,'identity.json'))},JSON.stringify({key,pid:launchSessionDrain(${JSON.stringify(home)})}));`);
 const host=spawn(process.execPath,[script],{env,stdio:['ignore','ignore','pipe']});let stderr='';host.stderr.on('data',b=>stderr+=b);const [code]=await once(host,'exit');expect(code,stderr).toBe(0);
 const {key,pid}=JSON.parse(readFileSync(join(home,'identity.json'),'utf8'));cleanup.push(()=>{try{process.kill(pid,'SIGKILL');}catch{/* exited */}});
 const mcp=spawn(process.execPath,[resolve('src/cli/main.ts'),'mcp','--client-id','synthetic-read','--capability','read','--global'],{env,stdio:['pipe','ignore','ignore']});mcp.stdin.end();expect((await once(mcp,'exit'))[0]).toBe(0);
 await until(()=>calls>0);expect(existsSync(join(config.dataRoot,'memory/preferences.md'))).toBe(false);
 if(crash){process.kill(pid,'SIGKILL');await pause(350);const restarted=spawn(process.execPath,[resolve('src/cli/main.ts'),'session-drain'],{env,stdio:'ignore'});cleanup.push(()=>restarted.kill('SIGKILL'));release=true;expect((await once(restarted,'exit'))[0]).toBe(0);}else release=true;
 await until(()=>{if(!existsSync(join(config.dataRoot,'memory/preferences.md')))return false;const store=new RuntimeStore(config.dataRoot);try{return new SessionIngress(store).status(key).complete;}finally{store.close();}});
 expect(readFileSync(join(config.dataRoot,'memory/preferences.md'),'utf8')).toContain('Prefer concise replies');expect(readdirSync(join(config.dataRoot,'runtime/receipts'))).toHaveLength(1);
},25000);
