import { randomUUID } from 'node:crypto';
import { SessionIngress, type SessionCacheOptions } from '../v2/session.js';
const processState = globalThis as typeof globalThis & {__commonMemoryPiInstance?:string};
export const piProcessInstance = processState.__commonMemoryPiInstance ??= randomUUID();
import type { RuntimeStore } from "../v2/runtime.js";

export interface SessionUserEntry { sequence?:number; id: string; text: string; timestamp: number }
export interface PiWriter { store: RuntimeStore; run(options?: {force?: boolean; signal?: AbortSignal}): Promise<unknown>; close(): void | Promise<void> }
/** Host lifecycle adapter. Delivery, rather than successful assistant completion, is evidence. */
export class PiCaptureRuntime {
  readonly #writer: PiWriter;
  readonly ingress:SessionIngress;
  #sessions=new Map<string,string>();
  readonly #abort = new AbortController();
  readonly #timer: ReturnType<typeof setInterval>;
  #stable = false;
  #closed = false;
  #closing: Promise<void> | undefined;
  #running: Promise<unknown> | undefined;
  constructor(writer: PiWriter, options:SessionCacheOptions = {}) {
    this.#writer = writer;
    this.ingress=new SessionIngress(writer.store,options);
    this.#timer = setInterval(() => this.check(), 1000);
    this.#timer.unref();
  }
  start(sessionId: string, entries: SessionUserEntry[]): void { this.bind(sessionId, entries); this.#stable = true; this.check(); }
  input(input: {sessionId:string;text:string;source:string;scope:string;streamingBehavior?:"steer"|"followUp";parentEntryId?:string|null;hasUnsupportedContent?:boolean}): void { this.#writer.store.transaction(()=>{const key=this.key(input.sessionId);this.#writer.store.stageInput({...input,sessionId:key});this.ingress.reserve(key,0);}); }
  delivered(sessionId:string,text:string,timestamp:number,hasUnsupportedContent=false): void { this.#writer.store.transaction(()=>{const key=this.key(sessionId);this.#writer.store.delivered(key,text,timestamp,hasUnsupportedContent);this.ingress.reserve(key,0);}); }
  bind(sessionId:string,entries:SessionUserEntry[]): void { const key=this.key(sessionId);this.#writer.store.bind(key,entries,input=>{
    const turn=this.#writer.store.db.prepare("SELECT turnId FROM session_turns WHERE sessionId=? AND state='open' ORDER BY id DESC LIMIT 1").get(key);
    this.ingress.capture(key,{id:input.entryId,turnId:turn?String(turn.turnId):input.entryId,...(entries.find(e=>e.id===input.entryId)?.sequence!==undefined?{sequence:entries.find(e=>e.id===input.entryId)!.sequence!}:{}),role:'user',text:input.text,source:input.source,scope:input.scope,observedAt:input.observedAt});
  }); }
  cancelInputs(sessionId:string): void { this.#writer.store.cancelInputs(this.key(sessionId)); }
  busy(): void { this.#stable = false; }
  settled(sessionId:string,entries:SessionUserEntry[],state:'settled'|'interrupted'='settled'): void { this.bind(sessionId,entries); this.cancelInputs(sessionId); const key=this.key(sessionId);for(const row of this.#writer.store.db.prepare("SELECT turnId FROM session_turns WHERE sessionId=? AND state='open'").all(key))this.ingress.settle(key,String(row.turnId),state); this.#stable = true; this.check(); }
  key(sessionId:string):string {let key=this.#sessions.get(sessionId);if(!key){key=this.ingress.open({client:'pi',processInstance:piProcessInstance,sessionId});this.#sessions.set(sessionId,key);}return key;}
  context(sessionId:string,entries:readonly {sequence?:number;id:string;role:'assistant'|'tool';text:string;timestamp:number}[]):void {
    const key=this.key(sessionId),turn=this.#writer.store.db.prepare("SELECT turnId FROM session_turns WHERE sessionId=? AND state='open' ORDER BY id DESC LIMIT 1").get(key);
    if(!turn)return;
    const first=this.#writer.store.db.prepare("SELECT observedAt,scope FROM session_messages WHERE sessionId=? AND role='user' AND turn=(SELECT id FROM session_turns WHERE sessionId=? AND turnId=?) ORDER BY id LIMIT 1").get(key,key,turn.turnId!);
    if(!first)return;
    for(const e of entries)if(e.timestamp>=Date.parse(String(first.observedAt)))this.ingress.capture(key,{...(e.sequence!==undefined?{sequence:e.sequence}:{}),id:e.id,turnId:String(turn.turnId),role:e.role,text:e.text,source:'conversation_context',scope:String(first.scope),observedAt:new Date(e.timestamp).toISOString()});
  }
  end(sessionId:string):void {this.ingress.end(this.key(sessionId));}
  flush(): void { this.#writer.store.requestFlush(); this.check(); }
  check(): void {
    if (this.#closed || !this.#stable || this.#running) return;
    this.#running = this.#writer.run({signal:this.#abort.signal}).then(result => {
      if (result && typeof result === 'object' && 'outcome' in result && result.outcome === 'failed') process.stderr.write('[common-memory] maintenance failed; inspect common-memory status for the diagnostic code.\n');
    }).catch(() => {
      process.stderr.write("[common-memory] maintenance failed; durable queue retained. Run common-memory status.\n");
    }).finally(() => { this.#running = undefined; });
  }
  shutdown(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true; clearInterval(this.#timer); this.#abort.abort();
    let flushFailed = false;
    try { this.#writer.store.requestFlush(); } catch { flushFailed = true; }
    return this.#closing = Promise.resolve(this.#running).then(async () => {
      try { await this.#writer.close(); }
      finally { if (flushFailed) throw new Error('Common Memory shutdown flush failed; resources closed'); }
    });
  }
}
