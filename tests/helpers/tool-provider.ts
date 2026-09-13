import type { ServerResponse } from 'node:http';
import type { MemoryTask, MemoryReadPort, StructuralBlock, ContentPage } from '../../src/core/contracts/memory-agent.js';
import { readTask } from './decision-runtime.js';

type Call = { id: string; name: string; args: Record<string, unknown>; apply?: (value: any) => void };
interface State {
  task: MemoryTask; queue: Call[]; pending: Map<string, Call>; processed: Set<string>;
  manifests: Map<string, StructuralBlock[]>; contents: Map<string, string>; documents: any[]; memory: Map<string, string>;
}
let serial = 0;
export function sendTools(res: Pick<ServerResponse, 'setHeader' | 'end'>, wire: any, calls: {name:string;args:unknown;id?:string}[]) {
  res.setHeader('content-type', 'text/event-stream');
  const event = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
  if (wire.messages) {
    res.end(event({ id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',tool_calls:calls.map((c,i)=>({index:i,id:c.id??`call_${++serial}`,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}}))},finish_reason:null}] }) + event({choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}) + 'data: [DONE]\n\n');
  } else {
    const items = calls.map(c => ({ type:'function_call',id:`fc_${++serial}`,call_id:c.id??`call_${++serial}`,name:c.name,arguments:JSON.stringify(c.args),status:'completed' }));
    res.end(items.map((item,i)=>event({type:'response.output_item.added',output_index:i,item:{...item,arguments:''}})+event({type:'response.function_call_arguments.delta',output_index:i,delta:item.arguments})+event({type:'response.output_item.done',output_index:i,item})).join('')+event({type:'response.completed',response:{id:'resp_synthetic',status:'completed',output:items,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}));
  }
}
/** Shared scripted provider explores REAL tools; historical oracles see only data returned by Core. */
export function toolProvider() {
  const states = new Map<string, State>();
  return (wire: any, res: Pick<ServerResponse,'setHeader'|'end'>): any | null => {
    const messages = wire.messages ?? wire.input;
    const user = messages.find((m:any) => m.role === 'user');
    const raw = typeof user?.content === 'string' ? user.content : user?.content?.map((c:any)=>c.text??'').join('');
    const task = JSON.parse(raw) as MemoryTask;
    const output = messages.filter((m:any)=>m.role === 'tool' || m.type === 'function_call_output');
    let state = states.get(task.request_id);
    if (!state || !output.length) {
      state = { task, queue:[],pending:new Map(),processed:new Set(),manifests:new Map(),contents:new Map(),documents:[],memory:new Map() };
      states.set(task.request_id,state);
      const current = state;
      const enqueue = (name:string,args:Record<string,unknown>,apply:(v:any)=>void) => current.queue.push({id:`call_${++serial}`,name,args,apply});
      const readBlock = (handle:string,block:string,offset=0) => enqueue('read_ingest',{handle,block,offset}, (page:ContentPage) => {
        const key=handle+'|'+block; current.contents.set(key,(current.contents.get(key)??'')+page.content);
        if(page.next!==null) readBlock(handle,block,page.next);
      });
      const manifest = (handle:string,offset=0) => enqueue('inspect_ingest',{handle,offset}, page => {
        current.manifests.set(handle,[...(current.manifests.get(handle)??[]),...page.blocks]);
        for(const block of page.blocks) readBlock(handle,block.block_id);
        if(page.next!==null) manifest(handle,page.next);
      });
      for(const bundle of task.bundles) manifest(bundle.ingest_id);
      const readMemory = (target:string,offset=0) => enqueue('inspect_memory',{handle:task.snapshot.handle,target,offset}, (page:ContentPage) => {
        current.memory.set(target,(current.memory.get(target)??'')+page.content);
        if(page.next!==null)readMemory(target,page.next);
      });
      enqueue('inspect_memory',{handle:task.snapshot.handle}, docs => {current.documents=docs;for(const doc of docs)readMemory(doc.target);});
    }
    for(const message of output) {
      const id=message.tool_call_id??message.call_id;
      if(state.processed.has(id))continue;
      const call=state.pending.get(id);if(!call)continue;
      const data=JSON.parse(message.content??message.output);
      if(typeof data==='string')throw new Error(data);
      state.processed.add(id);state.pending.delete(id);call.apply?.(data);
    }
    if(state.queue.length) {
      const calls=state.queue.splice(0,16);for(const call of calls)state.pending.set(call.id,call);
      sendTools(res,wire,calls);return null;
    }
    const reads:MemoryReadPort={
      manifest:handle=>({blocks:state!.manifests.get(handle)??[],next:null}),
      read:(handle,block)=>({descriptor:state!.manifests.get(handle)!.find(b=>b.block_id===block)!,block_id:block,content:state!.contents.get(handle+'|'+block)??'',bytes:0,offset:0,next:null}),
      memory:(_handle,target)=>target===undefined?state!.documents:{content:state!.memory.get(target),next:null},
      processing:()=>({complete:true,read_bytes:0,total_bytes:0}),
    };
    return readTask(task,reads).projection;
  };
}
