import { setTimeout } from 'node:timers/promises';
import type { RuntimeStore } from './runtime.js';
import { SessionIngress } from './session.js';
export interface DrainWriter { store:RuntimeStore; run(options?:{force?:boolean;signal?:AbortSignal}):Promise<unknown> }
/** Waits through backoff and foreign leases. Dead/quarantined work is terminal, never success. */
export async function drainSessions(writer:DrainWriter, options:{sessionId?:string;signal?:AbortSignal}={}):Promise<boolean> {
  const ingress=new SessionIngress(writer.store);
  for(;;) {
    options.signal?.throwIfAborted();
    const pending=options.sessionId ? writer.store.db.prepare("SELECT 1 FROM observations WHERE sessionId=? AND state IN ('pending','claimed') LIMIT 1").get(options.sessionId) : writer.store.hasWork();
    if(!pending) return options.sessionId ? ingress.status(options.sessionId).complete : !writer.store.hasIncompleteWork() && writer.store.db.prepare('SELECT id FROM sessions WHERE closing=1').all().every(row=>ingress.status(String(row.id)).complete);
    const result=await writer.run({force:true,...(options.signal?{signal:options.signal}:{})});
    if(result && typeof result==='object' && 'outcome' in result && (result.outcome==='idle'||result.outcome==='failed')) await setTimeout(250,undefined,{...(options.signal?{signal:options.signal}:{})});
  }
}
