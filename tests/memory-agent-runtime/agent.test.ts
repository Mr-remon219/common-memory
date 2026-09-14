import { Writer } from '../../src/v2/writer.js';
import type { MemoryTask, ContentPage, StructuralBlock, MemoryReadPort, MemoryAgentOptions } from '../../src/core/contracts/memory-agent.js';
import { tempRoots } from '../helpers/temp-roots.js';
import { afterEach, expect, it, vi } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { Agent, type AgentMessage, type StreamFn } from '@earendil-works/pi-agent-core';
import { PiMemoryAgent, memoryAgentSystem } from '../../src/memory-agent-runtime/agent.js';
import { providerModel } from '../../src/memory-agent-runtime/provider.js';
import { probeMemoryAgent } from '../../src/v2/connection-probe.js';
import { maintenanceSchema } from '../../src/v2/contract.js';
import { discoverMemorySkills, loadMemorySkill } from '../../src/memory-agent-runtime/skills.js';
import { MemoryModelError } from '../../src/core/contracts/errors.js';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const model=providerModel({model:'fake',baseUrl:'https://provider.test/v1'});
function response(calls:{name:string;args:unknown}[]=[],stop:Exclude<AssistantMessage['stopReason'],'pending'>=calls.length?'toolUse':'stop',usageTokens=7) {
  const message:AssistantMessage={role:'assistant',content:calls.map((c,i)=>({type:'toolCall',id:`call_${i}`,name:c.name,arguments:c.args as Record<string,unknown>})),api:model.api,model:model.id,provider:model.provider,
    timestamp:Date.now(),stopReason:stop,usage:{input:2,output:3,cacheRead:1,cacheWrite:1,totalTokens:usageTokens,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  const stream=new AssistantMessageEventStream();stream.push({type:'start',partial:message});
  if(stop==='error'||stop==='aborted')stream.push({type:'error',reason:stop,error:message});else stream.push({type:'done',reason:stop,message});
  return stream;
}
const decision={version:'memory_maintenance_v2',request_id:'network-test',decisions:[{kind:'ignore',confidence:1,applicability:'uncertain',evidence:[],reason:'Synthetic'}]};
const inspect={name:'inspect_ingest',args:{handle:'probe'}};
const read={name:'read_ingest',args:{handle:'probe',block:'probe-text'}};
const submit={name:'submit_memory_decision',args:decision};
it('runs real Pi tool rounds, delivers results, registers only bounded tools and stops after mixed submission',async()=>{
  let turn=0;
  const stream:StreamFn=(_model,context)=>{
    expect(context.systemPrompt).toBe(memoryAgentSystem);
    expect(context.tools!.map(t=>t.name)).toEqual(['load_memory_skill','inspect_ingest','read_ingest','inspect_memory','processing_state','record_working_notes','submit_memory_decision']);
    if(turn++===0){expect(JSON.stringify(context.messages)).not.toContain('No user facts');return response([inspect]);}
    if(turn===2){expect(context.messages.at(-1)).toMatchObject({role:'toolResult',isError:false});return response([read]);}
    return response([submit,{name:'processing_state',args:{}}]);
  };
  const agent=new PiMemoryAgent({model,stream:()=>stream});
  expect(await probeMemoryAgent(agent,new AbortController().signal)).toBe(true);expect(turn).toBe(3);
});
it('invalid tool arguments can self-correct without a false success',async()=>{
  let turn=0;
  const agent=new PiMemoryAgent({model,stream:()=> (_model,context)=>{
    if(turn++===0)return response([{name:'submit_memory_decision',args:{bad:true}}]);
    if(turn===2){expect(context.messages.at(-1)).toMatchObject({role:'toolResult',isError:true});return response([inspect,read]);}
    return response([submit]);
  }});
  expect(await directFixture().run(agent,{recover:async()=>true})).toMatchObject({body:decision});
});
it.each(['stop','length'] as const)('does not accept prose/truncated completion (%s)',async stop=>{
  const agent=new PiMemoryAgent({model,stream:()=>()=>response([],stop),maxAgentTurns:1});
  await expect(probeMemoryAgent(agent,new AbortController().signal)).rejects.toMatchObject({code:'INVALID_RESPONSE'});
});
it('classifies a stream error and provider abort instead of calling both incomplete',async()=>{
  await expect(probeMemoryAgent(new PiMemoryAgent({model,stream:()=>()=>response([submit],'error'),maxAgentTurns:1}),new AbortController().signal)).rejects.toMatchObject({code:'UNAVAILABLE',diagnostic:{reason:'stream_interrupted'}});
  await expect(probeMemoryAgent(new PiMemoryAgent({model,stream:()=>()=>response([submit],'aborted'),maxAgentTurns:1}),new AbortController().signal)).rejects.toMatchObject({code:'CANCELLED',diagnostic:{reason:'cancelled'}});
});
it('max turns bounds calls but unknown windows never silently discard early read turns',async()=>{
  let turns=0;
  const agent=new PiMemoryAgent({model,maxAgentTurns:10,stream:()=> (_model,context)=>{
    turns++;
    if(turns>8){expect(context.messages.length).toBeGreaterThan(15);expect(JSON.stringify(context.messages)).toContain('probe-text');}
    return response([inspect]);
  }});
  await expect(probeMemoryAgent(agent,new AbortController().signal)).rejects.toMatchObject({code:'AGENT_TURN_LIMIT',retryable:false});expect(turns).toBe(10);
});
it('cancellation reaches the active stream and no decision is returned',async()=>{
  const controller=new AbortController(),aborted=vi.fn();
  const agent=new PiMemoryAgent({model,stream:()=> (_model,_context,options)=>{
    const stream=new AssistantMessageEventStream();
    options!.signal!.addEventListener('abort',()=>{aborted();const ended=response([],'aborted');void ended.result().then(message=>stream.push({type:'error',reason:'aborted',error:message}));},{once:true});
    queueMicrotask(()=>controller.abort(new Error('CANCELLED')));return stream;
  }});
  await expect(probeMemoryAgent(agent,controller.signal)).rejects.toThrow('CANCELLED');expect(aborted).toHaveBeenCalledOnce();
});

it('known-window pressure preserves ephemeral draft progress and exact source references across eviction',async()=>{
  let turn=0;
  const agent=new PiMemoryAgent({model:{...model,contextWindow:12000},stream:()=> (_model,context)=>{
    if(turn++===0)return response([inspect,read,{name:'record_working_notes',args:{notes:'EARLY_CANDIDATE is tentative; source ev_1, block probe-text. Not authenticated evidence.'}}]);
    if(turn===2)return response([inspect],'toolUse',20000);
    expect(JSON.stringify(context.messages)).toContain('EARLY_CANDIDATE');
    expect(JSON.stringify(context.messages)).toContain('model-generated context-only');
    expect(JSON.stringify(context.messages)).toContain('probe-text');
    expect(context.messages.filter(m=>m.role==='assistant').flatMap(m=>m.content).some(b=>b.type==='toolCall' && b.name==='record_working_notes')).toBe(false);
    if(turn===3)return response([inspect],'toolUse',1); // low usage must not resurrect evicted turns
    return response([submit]);
  }});
  expect(await probeMemoryAgent(agent,new AbortController().signal)).toBe(true);expect(turn).toBe(4);
});
it('known-window exhaustion without retained draft progress fails instead of losing early findings',async()=>{
  const agent=new PiMemoryAgent({model:{...model,contextWindow:12000},stream:()=>()=>response([inspect],'toolUse',20000)});
  await expect(probeMemoryAgent(agent,new AbortController().signal)).rejects.toMatchObject({code:'CONTEXT_LIMIT',diagnostic:{reason:'context_length_exceeded'},retryable:false});
});

const {root:coreRoot,cleanup:cleanCoreRoots}=tempRoots('cm-agent-core-contract-');
afterEach(cleanCoreRoots);
function coreTask(messages:readonly import('@earendil-works/pi-ai').Message[]):MemoryTask {
 const content=messages[0]!.content;return JSON.parse(typeof content==='string'?content:content.filter(b=>b.type==='text').map(b=>b.text).join('')) as MemoryTask;
}
it('real Pi turn exhaustion pauses the whole Core job until explicitly resumed with durable counters',async()=>{
 let now=0,succeed=false;
 const agent=new PiMemoryAgent({model,maxAgentTurns:1,stream:()=> (_model,context)=>{
  const task=coreTask(context.messages),handle=task.bundles[0]!.ingest_id;
  return response([{name:'inspect_ingest',args:{handle}},...(succeed?[
   {name:'read_ingest',args:{handle,block:'text_0'}},
   {name:'submit_memory_decision',args:{...decision,request_id:task.request_id}},
  ]:[])]);
 }});
 const writer=new Writer({dataRoot:coreRoot(),allowedScopes:['global'],scheduler:{now:()=>now},agent});
 try {
  writer.store.enqueue({sessionId:'s',entryId:'one',scope:'global',source:'interactive',text:'Complete original input',observedAt:new Date(0).toISOString()});
  expect(await writer.run({force:true})).toMatchObject({outcome:'paused',reason:'AGENT_TURN_LIMIT'});
  expect(writer.store.status().jobs[0]).toMatchObject({state:'paused',attempts:1,diagnostic:{stage:'model_output',reason:'agent_turn_limit',retryable:false}});
  expect(writer.store.db.prepare('SELECT state,text FROM observations').get()).toEqual({state:'paused',text:'Complete original input'});
  expect(await writer.run()).toEqual({outcome:'idle'});writer.store.retry(writer.store.status().jobs[0]!.id);
  succeed=true;now=1001;expect(await writer.run({force:true})).toEqual({outcome:'ignored'});
  expect(writer.store.status().jobs[0]).toMatchObject({state:'done',attempts:2});
 } finally {writer.close();}
});
it('retains an early qualified source finding across later distractor pages and submits only after complete Core coverage',async()=>{
 let turn=0,task:MemoryTask,block:StructuralBlock,evictedEarly=false;
 const source='Only while reviewing Rust changes, prefer TERSE_COMMENTS. '+'DISTRACTOR_CONTEXT '.repeat(2000);
 function results<T>(messages:readonly import('@earendil-works/pi-ai').Message[],name:string):T[]{return messages.filter(m=>m.role==='toolResult' && m.toolName===name).flatMap(m=>typeof m.content==='string'?[]:m.content.filter(b=>b.type==='text').map(b=>JSON.parse(b.text) as T));}
 // Includes the explicit-edit prompt contract; 20K synthetic usage still forces eviction.
 const agent=new PiMemoryAgent({model:{...model,contextWindow:8000},stream:()=> (_model,context)=>{
  if(turn++===0){task=coreTask(context.messages);return response([{name:'inspect_ingest',args:{handle:task.bundles[0]!.ingest_id}},{name:'inspect_memory',args:{handle:task.snapshot.handle}}]);}
  const handle=task.bundles[0]!.ingest_id;
  if(turn===2){block=results<{blocks:StructuralBlock[]}>(context.messages,'inspect_ingest')[0]!.blocks[0]!;return response([{name:'read_ingest',args:{handle,block:block.block_id}},{name:'inspect_memory',args:{handle:task.snapshot.handle,target:'preferences'}}]);}
  const pages=results<ContentPage>(context.messages,'read_ingest'),last=pages.at(-1)!;
  if(turn===3){expect(last.content).toContain('Only while reviewing Rust changes, prefer TERSE_COMMENTS');return response([{name:'record_working_notes',args:{notes:`Candidate TERSE_COMMENTS ONLY while reviewing Rust changes; source ${block.evidence_ref}, block ${block.block_id}; keep this qualification, not a general preference.`}},{name:'read_ingest',args:{handle,block:block.block_id,offset:last.next}}],'toolUse',20000);}
  expect(JSON.stringify(context.messages)).toContain('TERSE_COMMENTS');expect(JSON.stringify(context.messages)).toContain('ONLY while reviewing Rust');
  expect(JSON.stringify(context.messages)).toContain(block.evidence_ref!);
  if(pages.every(page=>!page.content.includes('TERSE_COMMENTS')))evictedEarly=true;
  if(last.next!==null)return response([{name:'read_ingest',args:{handle,block:block.block_id,offset:last.next}}],'toolUse',20000);
  expect(evictedEarly).toBe(true);
  return response([{name:'submit_memory_decision',args:{version:'memory_maintenance_v2',request_id:task.request_id,decisions:[{kind:'retain',applicability:'global',confidence:1,admission:'remember',lifetime:'until_changed',evidence:[block.evidence_ref],reason:'synthetic qualified source',operations:[{op:'put_section',target:'preferences',section:null,title:'Rust review style',body:'Only while reviewing Rust changes, prefers terse comments.'}]}]}}]);
 }});
 const writer=new Writer({dataRoot:coreRoot(),allowedScopes:['global'],agent});
 try {
  writer.store.enqueue({sessionId:'s',entryId:'one',scope:'global',source:'interactive',text:source,observedAt:new Date(0).toISOString()});
  const completed = await writer.run({force:true});
  expect(completed,JSON.stringify(writer.store.status())).toEqual({outcome:'committed'});
  expect(writer.canonical.snapshot().find(d=>d.target==='preferences')!.content).toContain('Only while reviewing Rust changes, prefers terse comments.');
  expect(writer.store.status().observations).toEqual([{state:'processed',count:1}]);expect(turn).toBeGreaterThan(4);
 } finally {writer.close();}
});

it('context exhaustion resolves transformContext and stops at the stream boundary without another provider call',async()=>{
 const original=Agent.prototype.prompt;let resolved=0,rejected=0;
 const spy=vi.spyOn(Agent.prototype,'prompt').mockImplementation(async function(this:Agent,...args){
  const internal=this as unknown as {transformContext:(messages:AgentMessage[])=>Promise<AgentMessage[]>};const transform=internal.transformContext;
  internal.transformContext=async messages=>{try{const result=await transform(messages);resolved++;return result;}catch(error){rejected++;throw error;}};
  await Reflect.apply(original,this,args);
 });
 const provider=vi.fn<StreamFn>(()=>response([inspect],'toolUse',20000));
 try {const runtime=new PiMemoryAgent({model:{...model,contextWindow:12000},stream:()=>provider});await expect(probeMemoryAgent(runtime,new AbortController().signal)).rejects.toMatchObject({code:'CONTEXT_LIMIT',diagnostic:{reason:'context_length_exceeded'},retryable:false});expect(resolved).toBe(2);expect(rejected).toBe(0);expect(provider).toHaveBeenCalledTimes(1);}
 finally {spy.mockRestore();}
});

function directFixture() {
  const task:MemoryTask={version:'memory_task_v1',request_id:'network-test',now:'2026-01-01T00:00:00.000Z',bundles:[{ingest_id:'probe',source:'interactive',provenance:'user_explicit',scope:'global',block_count:1,bytes:12,state:'claimed'}],snapshot:{handle:'probe-memory',document_count:0},decision_schema:maintenanceSchema};
  let covered=false;
  const descriptor:StructuralBlock={block_id:'probe-text',parent_id:null,kind:'paragraph',order:0,bytes:12,evidence_ref:'ev_1',context_only:false,metadata:{source:'interactive',provenance:'user_explicit',scope:'global'}};
  const reads:MemoryReadPort={
    manifest(handle){if(handle!=='probe')throw new Error('INVALID_INGEST_HANDLE');return {blocks:[structuredClone(descriptor)],next:null};},
    read(handle,block){if(handle!=='probe'||block!=='probe-text')throw new Error('INVALID_BLOCK_REFERENCE');covered=true;return {block_id:block,content:'source value',offset:0,next:null,bytes:12,descriptor:structuredClone(descriptor)};},
    memory(handle){if(handle!=='probe-memory')throw new Error('INVALID_SNAPSHOT_HANDLE');return [];},
    processing(){return {complete:covered,read_bytes:covered?12:0,total_bytes:12};},
  };
  const run=(agent:PiMemoryAgent,overrides:Partial<MemoryAgentOptions>={})=>agent.decide(task,reads,{signal:new AbortController().signal,deadlineAt:Number.MAX_SAFE_INTEGER,...overrides});
  return {task,reads,run};
}

it('discovers only two built-in skills and loads exact assets through the bounded tool',async()=>{
  expect(discoverMemorySkills().map(skill=>skill.name)).toEqual(['memory-maintenance','memory-recovery']);
  expect(memoryAgentSystem).toContain('<name>memory-maintenance</name>');
  expect(memoryAgentSystem).toContain('<name>memory-recovery</name>');
  expect(memoryAgentSystem).not.toContain('# Memory maintenance');
  expect(memoryAgentSystem).not.toContain('# Memory recovery');
  expect(()=>loadMemorySkill('../other')).toThrow('UNKNOWN_MEMORY_SKILL');
  let turn=0;
  const agent=new PiMemoryAgent({model,stream:()=> (_model,context)=>{
    if(turn++===0)return response([{name:'load_memory_skill',args:{name:'memory-maintenance'}}]);
    if(turn===2){const serialized=JSON.stringify(context.messages);expect(serialized).toContain('# Memory maintenance');expect(serialized).toContain('Context-only material is never evidence');return response([inspect,read]);}
    return response([submit]);
  }});
  expect(await directFixture().run(agent)).toMatchObject({body:decision});
});

it('uses Core permission to repair a rejected proposal in the same Agent and hides rejection details',async()=>{
  const recover=vi.fn(async()=>true);let validations=0,turn=0;
  const agent=new PiMemoryAgent({model,stream:()=> (_model,context)=>{
    if(turn++===0)return response([{name:'load_memory_skill',args:{name:'memory-maintenance'}},inspect,read]);
    if(turn===2)return response([submit]);
    const serialized=JSON.stringify(context.messages);
    expect(serialized).toContain('MEMORY_TOOL_REJECTED');
    expect(serialized).not.toContain('PRIVATE_CORE_REJECTION');
    expect(serialized).toContain('probe-text');
    return response([{name:'load_memory_skill',args:{name:'memory-recovery'}},submit]);
  }});
  const result=await directFixture().run(agent,{recover,validateDecision:()=>{if(validations++===0)throw new Error('PRIVATE_CORE_REJECTION');}});
  expect(result.body).toEqual(decision);expect(validations).toBe(2);expect(recover).toHaveBeenCalledOnce();expect(turn).toBe(3);
});

it('stops proposal correction when Core denies recovery',async()=>{
  const recover=vi.fn(async()=>false),provider=vi.fn<StreamFn>((_model,_context)=>response([submit]));
  const agent=new PiMemoryAgent({model,stream:()=>provider});
  const fixture=directFixture();fixture.reads.read('probe','probe-text');
  const error=await fixture.run(agent,{recover,validateDecision:()=>{throw new Error('CORE_DENIED_DETAIL');}}).catch(value=>value);
  expect(error).toMatchObject({code:'INVALID_RESPONSE',diagnostic:{stage:'core_validation',reason:'core_rejected'}});
  expect(JSON.stringify(error)).not.toContain('CORE_DENIED_DETAIL');
  expect(provider).toHaveBeenCalledOnce();expect(recover).toHaveBeenCalledOnce();
});

it('routes TypeBox argument errors through Core recovery and strips raw rejected arguments',async()=>{
  let turn=0;const recover=vi.fn(async()=>true);
  const agent=new PiMemoryAgent({model,stream:()=> (_model,context)=>{
    if(turn++===0)return response([{name:'read_ingest',args:{handle:'PRIVATE_INVALID_ARGUMENT'}}]);
    expect(JSON.stringify(context.messages)).not.toContain('PRIVATE_INVALID_ARGUMENT');
    expect(JSON.stringify(context.messages)).toContain('MEMORY_TOOL_REJECTED');
    return response([inspect,read,submit]);
  }});
  expect(await directFixture().run(agent,{recover})).toMatchObject({body:decision});
  expect(recover).toHaveBeenCalledOnce();expect(turn).toBe(2);
});

it('continues the same Agent after a permitted stream interruption with reads and reasoning intact',async()=>{
  let turn=0;
  const unavailable=new MemoryModelError('UNAVAILABLE','PRIVATE_TRANSPORT_DETAIL',true,{stage:'response_body',reason:'network_error',retryable:true,httpStatus:200});
  const recover=vi.fn(async(error)=>{expect(error).toBe(unavailable);return true;});
  const interrupted=()=>{
    const message:AssistantMessage={role:'assistant',content:[{type:'thinking',thinking:'ACTUAL_REASONING_CONTENT'}],api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:'error',errorMessage:'PRIVATE_PROVIDER_MESSAGE',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    const stream=new AssistantMessageEventStream();stream.push({type:'start',partial:message});stream.push({type:'error',reason:'error',error:message});return stream;
  };
  const agent=new PiMemoryAgent({model,failure:()=>unavailable,stream:()=> (_model,context)=>{
    if(turn++===0)return response([inspect,read]);
    if(turn===2)return interrupted();
    const serialized=JSON.stringify(context.messages);
    expect(serialized).toContain('ACTUAL_REASONING_CONTENT');
    expect(serialized).toContain('probe-text');
    expect(serialized).toContain('Core permitted continuation of the same task');
    expect(serialized).not.toContain('PRIVATE_TRANSPORT_DETAIL');
    expect(serialized).not.toContain('PRIVATE_PROVIDER_MESSAGE');
    return response([{name:'load_memory_skill',args:{name:'memory-recovery'}},submit]);
  }});
  expect(await directFixture().run(agent,{recover})).toMatchObject({body:decision});
  expect(recover).toHaveBeenCalledOnce();expect(turn).toBe(3);
});

it('reports activity at exact model/tool boundaries and stops before provider on accounting failure',async()=>{
  const events:('model_turn'|'tool_call')[]=[];
  const agent=new PiMemoryAgent({model,stream:()=>()=>response([inspect,read,submit])});
  expect(await directFixture().run(agent,{onActivity:kind=>events.push(kind)})).toMatchObject({body:decision});
  expect(events).toEqual(['model_turn','tool_call','tool_call','tool_call']);
  const provider=vi.fn<StreamFn>(()=>response());
  const stopped=new PiMemoryAgent({model,stream:()=>provider});
  await expect(directFixture().run(stopped,{onActivity:()=>{throw new Error('ACTIVITY_LIMIT');}})).rejects.toThrow('ACTIVITY_LIMIT');
  expect(provider).not.toHaveBeenCalled();
  const fixture=directFixture(),manifest=vi.spyOn(fixture.reads,'manifest');
  const toolStopped=new PiMemoryAgent({model,stream:()=>()=>response([inspect])});
  await expect(fixture.run(toolStopped,{onActivity:kind=>{if(kind==='tool_call')throw new Error('TOOL_ACTIVITY_LIMIT');}})).rejects.toThrow('TOOL_ACTIVITY_LIMIT');
  expect(manifest).not.toHaveBeenCalled();
});


it('packages the system prompt and both built-in skill assets',()=>{
  const built=spawnSync(process.execPath,['scripts/build-assets.mjs'],{cwd:resolve('.'),encoding:'utf8'});
  expect(built.status,built.stderr).toBe(0);
  for(const name of ['memory-maintenance','memory-recovery']){
    const path=resolve('dist/memory-agent-runtime/skills',name,'SKILL.md');
    expect(existsSync(path)).toBe(true);expect(readFileSync(path,'utf8')).toContain(`name: ${name}`);
  }
  expect(readFileSync(resolve('dist/memory-agent-runtime/system.md'),'utf8')).toContain('Core alone authorizes facts');
});

it('never validates or accepts a proposal before complete current-source coverage',async()=>{
  let turn=0;const validateDecision=vi.fn(),recover=vi.fn(async()=>true);
  const agent=new PiMemoryAgent({model,stream:()=>()=>{
    if(turn++===0)return response([submit]);
    return response([inspect,read,submit]);
  }});
  expect(await directFixture().run(agent,{recover,validateDecision})).toMatchObject({body:decision});
  expect(recover).toHaveBeenCalledOnce();expect(validateDecision).toHaveBeenCalledOnce();expect(turn).toBe(2);
});
