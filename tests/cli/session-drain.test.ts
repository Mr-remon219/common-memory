import { toolProvider,sendTools } from '../helpers/tool-provider.js';
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
import { SessionIngress,sessionKey } from '../../src/v2/session.js';
import { startTestService } from '../helpers/service-daemon.js';
const cleanup:(()=>unknown|Promise<unknown>)[]=[];afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
async function until(f:()=>boolean){const end=Date.now()+15000;while(!f()){if(Date.now()>end)throw new Error('TIMED_OUT');await pause(50);}}
it.skipIf(process.platform!=='linux').each([false,true])('daemon finishes after the Pi channel exits; service crash recovery=%s',async crash=>{
 const home=mkdtempSync(join(tmpdir(),'cm-detached-'));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));let release=false,calls=0;const explore=toolProvider();
 const server=createServer(async(req,res)=>{let text='';for await(const b of req)text+=b;calls++;const wire=JSON.parse(text);await until(()=>release||res.destroyed);if(res.destroyed)return;const projection=explore(wire,res);if(!projection)return;sendTools(res,wire,[{name:'submit_memory_decision',args:{version:'memory_maintenance_v2',request_id:projection.request_id,decisions:[{kind:'retain',applicability:'global',admission:'remember',lifetime:'until_changed',confidence:1,evidence:projection.observations.map((o:{ref:string})=>o.ref),reason:'synthetic',operations:[{op:'put_section',target:'preferences',section:null,title:'Synthetic preference',body:'Prefer concise replies.'}]}]}}]);});server.listen(0,'127.0.0.1');await once(server,'listening');cleanup.push(()=>{release=true;server.closeAllConnections();return new Promise<void>(r=>server.close(()=>r()));});
 const config=defaultConfig({COMMON_MEMORY_HOME:home});config.remote={provider:'openai-compatible',model:'fake',baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,apiKeyEnv:'CM_TEST_KEY',proxy:{mode:'direct'}};config.scheduler.leaseMs=300;writeFileSync(join(home,'config.json'),JSON.stringify(config));writeFileSync(join(home,'.env'),'CM_TEST_KEY="synthetic-key"\n',{mode:0o600});
 const channel={kind:'pi' as const,processInstance:'synthetic-host'},loader=pathToFileURL(resolve('tests/mcp/fixtures/source-loader.mjs')).href,env={...process.env,COMMON_MEMORY_HOME:home,NODE_OPTIONS:`--import=${loader}`};let stop=await startTestService(home,[channel]);cleanup.push(async()=>stop());
 const script=join(home,'host.mjs');writeFileSync(script,`import {ServiceClient} from ${JSON.stringify(pathToFileURL(resolve('src/service/client.ts')).href)};const c=new ServiceClient(${JSON.stringify(channel)},${JSON.stringify(home)}),h={sessionId:'s',cwd:${JSON.stringify(home)}};await c.call('pi.start',{...h,entries:[]},{requestId:'start'});await c.call('pi.input',{...h,text:'Please prefer concise replies.',source:'interactive'},{requestId:'input'});await c.call('pi.delivered',{...h,text:'Please prefer concise replies.',timestamp:1,hasUnsupportedContent:false},{requestId:'delivered'});await c.call('pi.bind',{...h,entries:[{id:'u',text:'Please prefer concise replies.',timestamp:1}]},{requestId:'bind'});await c.call('pi.settled',{...h,entries:[{id:'u',text:'Please prefer concise replies.',timestamp:1}],state:'settled'},{requestId:'settled'});await c.call('pi.end',h,{requestId:'end'});`);
 const host=spawn(process.execPath,[script],{env,stdio:['ignore','ignore','pipe']});let stderr='';host.stderr.on('data',b=>stderr+=b);expect((await once(host,'exit'))[0],stderr).toBe(0);const key=sessionKey({client:'pi',processInstance:'synthetic-host',sessionId:'s'});
 await until(()=>calls>0);expect(existsSync(join(config.dataRoot,'memory/preferences.md'))).toBe(false);
 if(crash){stop.child.kill('SIGKILL');await once(stop.child,'exit');await stop();stop=await startTestService(home,[channel]);}release=true;
 await until(()=>{if(!existsSync(join(config.dataRoot,'memory/preferences.md')))return false;const store=new RuntimeStore(config.dataRoot);try{return new SessionIngress(store).status(key).complete;}finally{store.close();}});
 expect(readFileSync(join(config.dataRoot,'memory/preferences.md'),'utf8')).toContain('Prefer concise replies');expect(readdirSync(join(config.dataRoot,'runtime/receipts'))).toHaveLength(1);
},25000);
