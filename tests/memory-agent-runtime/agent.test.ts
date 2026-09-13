import { Writer } from '../../src/v2/writer.js';
import type { MemoryTask, ContentPage, StructuralBlock } from '../../src/core/contracts/memory-agent.js';
import { tempRoots } from '../helpers/temp-roots.js';
import { afterEach, expect, it, vi } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { Agent, type AgentMessage, type StreamFn } from '@earendil-works/pi-agent-core';
import { PiMemoryAgent, memoryAgentSystem } from '../../src/memory-agent-runtime/agent.js';
import { providerModel } from '../../src/memory-agent-runtime/provider.js';
import { probeMemoryAgent } from '../../src/v2/connection-probe.js';

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
    expect(context.tools!.map(t=>t.name)).toEqual(['inspect_ingest','read_ingest','inspect_memory','processing_state','record_working_notes','submit_memory_decision']);
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
  expect(await probeMemoryAgent(agent,new AbortController().signal)).toBe(true);
});
it.each(['stop','length','error','aborted'] as const)('does not accept prose/truncated/error completion (%s)',async stop=>{
  const agent=new PiMemoryAgent({model,stream:()=>()=>response([submit],stop),maxAgentTurns:1});
  await expect(probeMemoryAgent(agent,new AbortController().signal)).rejects.toMatchObject({code:'INVALID_RESPONSE'});
});
it('max turns bounds calls but unknown windows never silently discard early read turns',async()=>{
  let turns=0;
  const agent=new PiMemoryAgent({model,maxAgentTurns:10,stream:()=> (_model,context)=>{
    turns++;
    if(turns>8){expect(context.messages.length).toBeGreaterThan(15);expect(JSON.stringify(context.messages)).toContain('probe-text');}
    return response([inspect]);
  }});
  await expect(probeMemoryAgent(agent,new AbortController().signal)).rejects.toMatchObject({code:'INVALID_RESPONSE',retryable:true});expect(turns).toBe(10);
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
  await expect(probeMemoryAgent(agent,new AbortController().signal)).rejects.toMatchObject({diagnostic:{reason:'context_length_exceeded'},retryable:true});
});

const {root:coreRoot,cleanup:cleanCoreRoots}=tempRoots('cm-agent-core-contract-');
afterEach(cleanCoreRoots);
function coreTask(messages:readonly import('@earendil-works/pi-ai').Message[]):MemoryTask {
 const content=messages[0]!.content;return JSON.parse(typeof content==='string'?content:content.filter(b=>b.type==='text').map(b=>b.text).join('')) as MemoryTask;
}
it('real Pi turn exhaustion leaves the whole Core job retryable and its next attempt can complete',async()=>{
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
  expect(await writer.run({force:true})).toMatchObject({outcome:'failed',reason:'INVALID_RESPONSE'});
  expect(writer.store.status().jobs[0]).toMatchObject({state:'retry',attempts:1,diagnostic:{stage:'model_output',reason:'incomplete_output',retryable:true}});
  expect(writer.store.db.prepare('SELECT state,text FROM observations').get()).toEqual({state:'claimed',text:'Complete original input'});
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
 try {const runtime=new PiMemoryAgent({model:{...model,contextWindow:12000},stream:()=>provider});await expect(probeMemoryAgent(runtime,new AbortController().signal)).rejects.toMatchObject({diagnostic:{reason:'context_length_exceeded'},retryable:true});expect(resolved).toBe(2);expect(rejected).toBe(0);expect(provider).toHaveBeenCalledTimes(1);}
 finally {spy.mockRestore();}
});
