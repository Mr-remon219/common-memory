import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,expect,it } from 'vitest';
import { SessionIngress,sessionProjection } from '../../src/v2/session.js';
import { RuntimeStore } from '../../src/v2/runtime.js';
import { Writer } from '../../src/v2/writer.js';
import { drainSessions } from '../../src/v2/session-drain.js';
import type { ApprovedModelRequest } from '../../src/memory-manager/contracts/model-port.js';
const cleanup:(()=>void)[]=[];
afterEach(()=>cleanup.splice(0).reverse().forEach(f=>f()));
function root(){const p=mkdtempSync(join(tmpdir(),'session-'));cleanup.push(()=>rmSync(p,{recursive:true,force:true}));return p;}
const message=(id:string,turnId=id,text='user expression')=>({id,turnId,text,role:'user' as const,source:'interactive',scope:'global',observedAt:'2026-09-09T00:00:00.000Z'});
function fixture(){const store=new RuntimeStore(root());cleanup.push(()=>store.close());const ingress=new SessionIngress(store);const a=ingress.open({client:'pi',processInstance:'process-a',sessionId:'a'}),b=ingress.open({client:'pi',processInstance:'process-a',sessionId:'b'});return {store,ingress,a,b};}
it('isolates nine plus nine; tenth settled seals immediately independently of legacy thresholds',()=>{
 const {store,ingress,a,b}=fixture();for(let i=0;i<9;i++)for(const key of [a,b]){ingress.capture(key,message(String(i)));ingress.settle(key,String(i));}
 store.requestFlush();expect(store.claim({force:true})).toBeNull();
 ingress.capture(a,message('9'));expect(store.claim()).toBeNull();ingress.settle(a,'9');
 const job=store.claim()!;expect(job.observations).toHaveLength(10);expect(new Set(job.observations.map(o=>o.sessionId))).toEqual(new Set([a]));expect(ingress.status(b).batches).toBe(0);
});
it('21 interactions yield 10+10+1 with duplicates and delivery grouping',()=>{
 const {store,ingress,a}=fixture();for(let i=0;i<21;i++){const m=message(String(i));ingress.capture(a,m);ingress.capture(a,m);ingress.capture(a,message(`steer-${i}`,String(i)));ingress.settle(a,String(i));ingress.settle(a,String(i));}
 expect(ingress.status(a).batches).toBe(2);ingress.end(a);ingress.end(a);expect(ingress.status(a).batches).toBe(3);
 const sizes=[];for(let job=store.claim();job;job=store.claim()){sizes.push(job.observations.length);store.finish(job);}
 expect(sizes).toEqual([20,20,2]);expect(ingress.status(a).complete).toBe(true);
});
it('capacity refusal preserves existing bodies and allows terminal envelopes',()=>{
 const {store,a}=fixture(),ingress=new SessionIngress(store,{maxSessionBytes:20,maxTotalBytes:30});ingress.capture(a,message('a','a','1234567890'));
 expect(()=>ingress.capture(a,message('b','a','x'.repeat(11)))).toThrow('SESSION_CAPACITY_EXCEEDED');
 ingress.end(a);expect(ingress.status(a)).toMatchObject({batches:1,complete:false});expect(store.pending()[0]!.text).toBe('1234567890');expect(()=>ingress.capture(a,message('c'))).toThrow('SESSION_CLOSED');
});
it('mixed provenance quarantines the whole interaction and unconfirmed inputs do not count',()=>{
 const {store,ingress,a}=fixture();ingress.settle(a,'undelivered');ingress.capture(a,message('u','t'));ingress.capture(a,{...message('x','t'),source:'ambiguous'});ingress.settle(a,'t');ingress.end(a);
 expect(store.pending()).toHaveLength(0);expect(ingress.status(a)).toMatchObject({batches:1,failed:2,complete:false});
});
it('context requires separate authorization and forget/prune invalidate bodies without resurrection on replay',()=>{
 const {store,ingress,a}=fixture();const user=message('u');const assistant={...message('a','u','assistant suggestion'),role:'assistant' as const,source:'conversation_context'};
 ingress.capture(a,user);ingress.capture(a,assistant);ingress.settle(a,'u');ingress.end(a);const job=store.claim()!;
 expect(JSON.stringify(sessionProjection(store,job,false))).not.toContain('assistant suggestion');expect(JSON.stringify(sessionProjection(store,job,true))).toContain('assistant suggestion');
 store.finish(job,{jobId:job.id,observationIds:job.observations.map(o=>o.id),forgetSourceIds:job.observations.map(o=>o.id)});
 ingress.capture(a,user);ingress.capture(a,assistant);expect(store.db.prepare("SELECT text,unavailable FROM session_messages WHERE role='assistant'").get()).toEqual({text:null,unavailable:'source_unavailable'});
 expect(JSON.stringify(sessionProjection(store,job,true))).not.toContain('assistant suggestion');
});
function response(r:ApprovedModelRequest){return {kind:'output' as const,usage:{inputTokens:0,outputTokens:0},body:{version:'memory_maintenance_v2',request_id:r.projection.request_id,decisions:[{kind:'ignore',applicability:'uncertain',confidence:1,evidence:[],reason:'synthetic'}]}};}
it('Writer splits only between complete interactions and preserves oversized whole turns',async()=>{
 const requests:ApprovedModelRequest[]=[];
 const writer=new Writer({dataRoot:root(),allowedScopes:['global'],allowedProvenance:['user_explicit','conversation_context'],maxRequestBytes:20000,model:{async analyze(r){requests.push(r);return response(r);}}});cleanup.push(()=>writer.close());const ingress=new SessionIngress(writer.store),key=ingress.open({client:'pi',processInstance:'p',sessionId:'s'});
 for(const turn of ['a','b']){ingress.capture(key,message(turn,turn,'x'.repeat(4000)));ingress.capture(key,message(turn+'-steer',turn,'confirm'));ingress.capture(key,{...message(turn+'-assistant',turn,'suggestion'),role:'assistant',source:'conversation_context'});ingress.settle(key,turn);}
 ingress.end(key);await drainSessions(writer,{sessionId:key});expect(requests.length).toBe(2);for(const r of requests)expect(r.projection.observations).toHaveLength(2);
});
it('drain actually waits for retry instead of declaring idle success',async()=>{
 let attempts=0;const writer=new Writer({dataRoot:root(),allowedScopes:['global'],model:{async analyze(r){if(!attempts++)throw new Error('temporary');return response(r);}}});cleanup.push(()=>writer.close());
 const ingress=new SessionIngress(writer.store),key=ingress.open({client:'pi',processInstance:'p',sessionId:'s'});ingress.capture(key,message('u'));ingress.settle(key,'u');ingress.end(key);
 expect(await drainSessions(writer,{sessionId:key})).toBe(true);expect(attempts).toBe(2);expect(writer.store.status().jobs[0]!.attempts).toBe(2);
});
it('sealed sessions bypass an ineligible legacy head without mixing it into the job',()=>{
 const {store,ingress,a}=fixture();store.enqueue({sessionId:'legacy',entryId:'l',text:'legacy',scope:'global',source:'rpc',observedAt:'2026-09-09T00:00:00Z'});
 ingress.capture(a,message('u'));ingress.settle(a,'u');ingress.end(a);const job=store.claim()!;expect(job.observations.map(o=>o.sessionId)).toEqual([a]);store.finish(job);expect(store.claim()).toBeNull();
});
it('an oversized complete interaction quarantines all user expressions together and retains the original bodies',async()=>{
 let calls=0;const writer=new Writer({dataRoot:root(),allowedScopes:['global'],allowedProvenance:['user_explicit','conversation_context'],maxRequestBytes:20000,model:{async analyze(r){calls++;return response(r);}}});cleanup.push(()=>writer.close());const ingress=new SessionIngress(writer.store),key=ingress.open({client:'pi',processInstance:'p',sessionId:'oversized'});
 ingress.capture(key,message('suggested','t','x'.repeat(18000)));ingress.capture(key,message('confirm','t','I confirm'));ingress.capture(key,{...message('assistant','t','related suggestion'),role:'assistant',source:'conversation_context'});ingress.settle(key,'t');ingress.end(key);
 expect((await writer.run()).outcome).toBe('quarantined');expect(calls).toBe(0);expect(ingress.status(key).failed).toBe(2);expect(writer.store.db.prepare("SELECT length(text) AS n FROM observations WHERE entryId='suggested'").get()!.n).toBe(18000);
});
it('closing an unsettled mixed-scope interaction quarantines the whole turn',()=>{
 const {store,ingress,a}=fixture();ingress.capture(a,message('a','t'));ingress.capture(a,{...message('b','t'),scope:'project:other'});ingress.end(a);expect(store.pending()).toHaveLength(0);expect(ingress.status(a)).toMatchObject({failed:2,complete:false});
});
it('legacy prior user context also needs conversation_context permission',async()=>{
 const requests:ApprovedModelRequest[]=[];const writer=new Writer({dataRoot:root(),allowedScopes:['global'],allowedProvenance:['user_explicit'],model:{async analyze(r){requests.push(r);return response(r);}}});cleanup.push(()=>writer.close());
 for(const entryId of ['first','second']){writer.store.enqueue({sessionId:'legacy',entryId,text:'user '+entryId,source:'interactive',scope:'global',observedAt:'2026-09-09T00:00:00Z'});await writer.run({force:true});}
 expect(requests[1]!.projection.context_only).toEqual([]);
});
