import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, saveConfig, saveApiKeyToEnvFile } from '../../src/config/config.js';
import { createConfiguredWriter } from '../../src/config/runtime.js';
import { toolProvider, sendTools } from '../helpers/tool-provider.js';
const roots:string[]=[];
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
function setup(){const home=mkdtempSync(join(tmpdir(),'cm-refresh-'));roots.push(home);vi.stubEnv('COMMON_MEMORY_HOME',home);const config=defaultConfig();delete config.remote.proxy;config.remote.model='model-a';config.remote.baseUrl='https://first.test/v1';saveConfig(config);saveApiKeyToEnvFile(config.remote.apiKeyEnv,'synthetic-a');return {home,config};}
it('keeps an in-flight task snapshot, then sends all newly saved model settings on real Pi HTTP requests',async()=>{
 const {config}=setup(),next=structuredClone(config);next.remote.model='model-b';next.remote.baseUrl='https://second.test/v1';next.remote.api='chat_completions';next.remote.reasoningEffort='high';next.remote.thinking={type:'enabled'};next.remote.maxOutputTokens=777;next.remote.maxAgentTurns=32;
 const wires:{url:string;key:string|null;body:Record<string,unknown>}[]=[],explore=toolProvider();let changed=false;
 vi.stubGlobal('fetch',async(url:unknown,init:RequestInit)=>{
  const body=JSON.parse(String(init.body));wires.push({url:String(url),key:new Headers(init.headers).get('authorization'),body});
  if(!changed){changed=true;saveApiKeyToEnvFile(next.remote.apiKeyEnv,'synthetic-b');saveConfig(next);}
  let data='';const res={setHeader:()=>{},end:(text:unknown)=>{data=String(text);}};const task=explore(body,res as never);
  if(task)sendTools(res as never,body,[{name:'submit_memory_decision',args:{version:'memory_maintenance_v2',request_id:task.request_id,decisions:[{kind:'ignore',confidence:1,applicability:'uncertain',evidence:[],reason:'synthetic'}]}}]);
  return new Response(data,{headers:{'content-type':'text/event-stream'}});
 });
 const writer=createConfiguredWriter(config);const add=(id:string)=>writer.store.enqueue({sessionId:'synthetic',entryId:id,text:'Synthetic preference\npassword: [REDACTED]\nOnly on weekends.',source:'interactive',scope:'global',observedAt:'2026-09-01T00:00:00Z'});
 try{
  add('first');expect(await writer.run({force:true})).toMatchObject({outcome:'ignored'});const boundary=wires.length,firstVersion=writer.agent.configurationVersion;
  expect(boundary).toBeGreaterThan(2);for(const wire of wires){expect(wire.url).toContain('first.test');expect(wire.key).toBe('Bearer synthetic-a');expect(wire.body.model).toBe('model-a');}
  add('second');expect(await writer.run({force:true})).toMatchObject({outcome:'ignored'});expect(writer.agent.configurationVersion).not.toBe(firstVersion);
  for(const wire of wires.slice(boundary)){expect(wire.url).toContain('second.test');expect(wire.key).toBe('Bearer synthetic-b');expect(wire.body).toMatchObject({model:'model-b',reasoning_effort:'high',thinking:{type:'enabled'},max_completion_tokens:777});}
  expect(writer.store.db.prepare('SELECT COUNT(*) n FROM receipts').get()!.n).toBe(2);
 }finally{await writer.close();}
});
it('does not consume queued input or use cached credentials during an incomplete configuration transaction',async()=>{
 const {home,config}=setup(),fetch=vi.fn();vi.stubGlobal('fetch',fetch);const writer=createConfiguredWriter(config);
 try{writer.store.enqueue({sessionId:'s',entryId:'e',text:'Synthetic preference',source:'interactive',scope:'global',observedAt:'2026-09-01T00:00:00Z'});mkdirSync(join(home,'.installation'),{recursive:true});writeFileSync(join(home,'.installation/transaction.json'),'[]');expect(await writer.run()).toEqual({outcome:'paused',reason:'CONFIGURATION'});expect(writer.store.pending()).toHaveLength(1);expect(writer.store.systemPause()).toBe('CONFIGURATION');expect(fetch).not.toHaveBeenCalled();}finally{await writer.close();}
});
