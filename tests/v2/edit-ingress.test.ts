import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { tempRoots } from '../helpers/temp-roots.js';
import { readTask } from '../helpers/decision-runtime.js';
import { RuntimeStore } from '../../src/v2/runtime.js';
import { Writer } from '../../src/v2/writer.js';
import { queueMemoryEdit } from '../../src/v2/edit-ingress.js';
import { nextForOutcome } from '../../src/v2/service-guidance.js';
import { scopedQueueStatus } from '../../src/v2/service-status.js';
import type { MemoryAgentRuntime, MemoryTask, MemoryReadPort } from '../../src/core/contracts/memory-agent.js';

const roots = tempRoots('cm-edit-contract-');
const cleanup: (()=>void)[] = [];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();roots.cleanup();});
const access = {allowedScopes:['global'],writableScopes:['global'],allowedProvenance:['user_explicit'],limits:{}};
const input = {sessionId:'trusted-editor',requestId:'original',scope:'global',text:'Forget the absent preference.'};
const ordinary = {sessionId:'session',entryId:'turn',scope:'global',source:'interactive',observedAt:'2026-01-01T00:00:00Z',text:'A statement.'};
function answer(task:MemoryTask, reads:MemoryReadPort, result?: string, read = true, modified = false) {
  const projection = read ? readTask(task,reads).projection as {observations:{ref:string}[]} : undefined;
  return {body:{version:'memory_maintenance_v2',request_id:task.request_id,...(result ? {edit_result:result} : {}),decisions:[{
    kind:modified?'retain':'ignore',applicability:'global',confidence:1,evidence:projection?.observations.map(o=>o.ref)??[],reason:'PRIVATE_MODEL_REASON_NOT_A_DIAGNOSTIC',
    ...(modified?{admission:'correct',lifetime:'until_changed',operations:[{op:'put_section',target:'preferences',section:null,title:'Style',body:'Use concise prose.'}]}:{}),
  }]},usage:{},promptDigest:'a'.repeat(64)};
}
function fixture(decide:MemoryAgentRuntime['decide'],checkpoint?:()=>void) {
  const root=roots.root();const writer=new Writer({dataRoot:root,allowedScopes:['global'],agent:{decide},...(checkpoint?{checkpoint}:{})});cleanup.push(()=>writer.close());
  queueMemoryEdit(writer.store,input,access);return {root,writer};
}
it('old observations migrate idempotently without upgrading interactive provenance or changing bundles/leases',()=>{
  const root=roots.root();let store=new RuntimeStore(root);store.enqueue(ordinary);const job=store.claim({force:true})!;
  const before=store.db.prepare('SELECT * FROM ingest_blocks').all();
  store.db.exec('ALTER TABLE observations DROP COLUMN taskKind; ALTER TABLE jobs DROP COLUMN editResult');store.close();
  store=new RuntimeStore(root);expect(store.db.prepare('SELECT id,taskKind,jobId,state FROM observations').get()).toEqual({id:1,taskKind:'observation',jobId:job.id,state:'claimed'});
  expect(store.db.prepare('SELECT * FROM ingest_blocks').all()).toEqual(before);store.assertLease(job);store.finish(job);store.close();
  store=new RuntimeStore(root);cleanup.push(()=>store.close());expect(store.observationOutcome('session','turn')).toMatchObject({state:'processed'});
  expect(store.observationOutcome('session','turn')).not.toHaveProperty('editResult');
});
it('explicit requests are single tasks, do not mix with learning or other edits, and cannot replay under another task kind',()=>{
  const store=new RuntimeStore(roots.root());cleanup.push(()=>store.close());store.enqueue(ordinary);
  queueMemoryEdit(store,input,access);queueMemoryEdit(store,{...input,requestId:'second'},access);
  store.enqueue({...ordinary,entryId:'later'});
  expect(queueMemoryEdit(store,input,access).duplicate).toBe(true);
  expect(()=>store.enqueue({...ordinary,sessionId:input.sessionId,entryId:input.requestId,text:input.text})).toThrow('Conflicting observation identity');
  for(const kind of ['observation','edit','edit','observation']) {
    const job=store.claim({force:true})!;expect(job.observations).toHaveLength(1);expect(job.observations[0]!.taskKind).toBe(kind);
    if(kind==='edit') expect(()=>store.finish(job)).toThrow('Missing edit receipt result');
    store.finish(job,{jobId:job.id,observationIds:job.observations.map(o=>o.id),...(kind==='edit'?{editResult:'already_satisfied' as const}:{})});
  }
  expect(()=>store.enqueue({...ordinary,entryId:'import',source:'agent_import',taskKind:'edit'})).toThrow('INVALID_TASK_KIND');
});
it.each(['already_satisfied','clarification_required','refused'])('persists bounded %s without a forced write or free-form diagnostic',async result=>{
  const {root,writer}=fixture(async(task,reads)=>{expect(task.task_kind).toBe('edit');return answer(task,reads,result);});
  expect(await writer.run()).toEqual({outcome:'ignored'});
  const outcome=writer.store.observationOutcome(input.sessionId,input.requestId)!;
  expect(outcome).toMatchObject({state:'processed',editResult:result,diagnostic:null});expect(outcome.retainedIn).toEqual([]);
  expect(nextForOutcome(outcome,{requestId:input.requestId},['global']).action).toBe(result==='already_satisfied'?'read':'review');
  expect(JSON.stringify(scopedQueueStatus(writer.store,['global']))).not.toContain('PRIVATE_MODEL_REASON');
  const reopened=new RuntimeStore(root);try{expect(reopened.observationOutcome(input.sessionId,input.requestId)).toEqual(outcome);}finally{reopened.close();}
});
it.each([undefined,'invented_result','modified'])('ordinary ignore or invalid result %s cannot complete an edit',async result=>{
  const {writer}=fixture(async(task,reads)=>answer(task,reads,result));
  expect((await writer.run()).outcome).toBe('failed');expect(writer.store.observationOutcome(input.sessionId,input.requestId)).toMatchObject({state:'claimed',jobState:'retry'});
});
it('even a refusal requires full current-source coverage',async()=>{
  const {writer}=fixture(async(task,reads)=>answer(task,reads,'refused',false));
  expect(await writer.run()).toMatchObject({outcome:'failed',reason:'INCOMPLETE_INGEST_COVERAGE'});
});
it('already satisfied must read complete current targets and a concurrent manual edit fails CAS',async()=>{
  let mutate=false;
  const {root,writer}=fixture(async(task,reads)=>{
    if(mutate){const result=answer(task,reads,'already_satisfied');writeFileSync(join(root,'memory/preferences.md'),'# Preferences\n\n## Manual\nChanged concurrently.\n');return result;}
    for(const bundle of task.bundles)for(const block of reads.manifest(bundle.ingest_id).blocks)reads.read(bundle.ingest_id,block.block_id);
    return answer(task,reads,'already_satisfied',false);
  });
  expect(await writer.run()).toMatchObject({outcome:'failed',reason:'UNREAD_MEMORY_TARGET'});
  writer.store.db.exec("UPDATE jobs SET available=0");mutate=true;
  mkdirSync(join(root,'memory'),{recursive:true});
  expect(await writer.run()).toMatchObject({outcome:'failed',reason:'STALE_REVISION'});
});
it('modified result follows canonical receipt recovery after the files-before-DB boundary',async()=>{
  const decide=vi.fn(async(task:MemoryTask,reads:MemoryReadPort)=>answer(task,reads,'modified',true,true));
  const {root,writer}=fixture(decide,()=>{throw new Error('synthetic DB interruption');});
  expect(await writer.run()).toEqual({outcome:'committed'});
  expect(readFileSync(join(root,'memory/preferences.md'),'utf8')).toContain('Use concise prose.');
  expect(writer.store.observationOutcome(input.sessionId,input.requestId)).toMatchObject({state:'processed',editResult:'modified'});
  expect(decide).toHaveBeenCalledTimes(1);
  // The immutable receipt itself, not an in-memory return, owns the recoverable result.
  const find=(path:string):string[]=>readdirSync(path,{withFileTypes:true}).flatMap(e=>e.isDirectory()?find(join(path,e.name)):[join(path,e.name)]);
  const receipts=find(root).filter(p=>p.endsWith('.json')).map(p=>readFileSync(p,'utf8')).join('\n');
  expect(receipts).toContain('"editResult":"modified"');expect(receipts).not.toContain('PRIVATE_MODEL_REASON');
  writer.recover();expect(decide).toHaveBeenCalledTimes(1);
});

it.each([false,true])('edit maintenance requires a current request source link (evidence=%s)',async evidence=>{
  const {root,writer}=fixture(async(task,reads)=>{
    const response=answer(task,reads,'modified',true,true);
    const {admission:_admission,lifetime:_lifetime,...decision}=response.body.decisions[0]!;
    return {...response,body:{...response.body,decisions:[{...decision,kind:'maintain',evidence:evidence?decision.evidence:[]}]}};
  });
  expect(await writer.run()).toMatchObject(evidence?{outcome:'committed'}:{outcome:'failed',reason:'MISSING_EVIDENCE'});
  const outcome=writer.store.observationOutcome(input.sessionId,input.requestId)!;
  if(evidence){expect(outcome.retainedIn.length).toBeGreaterThan(0);expect(outcome.editResult).toBe('modified');}
  else{expect(outcome.retainedIn).toEqual([]);expect(existsSync(join(root,'memory/preferences.md'))).toBe(false);}
});
it('ordinary interactive tasks cannot self-promote through an edit result',async()=>{
  const writer=new Writer({dataRoot:roots.root(),allowedScopes:['global'],agent:{decide:async(task,reads)=>{expect(task.task_kind).toBe('observation');return answer(task,reads,'already_satisfied');}}});cleanup.push(()=>writer.close());
  writer.store.enqueue(ordinary);expect(await writer.run({force:true})).toMatchObject({outcome:'failed',reason:'INVALID_DECISION'});
});
it('native request IDs remain queryable by the existing status identity schema',()=>{
  const store=new RuntimeStore(roots.root());cleanup.push(()=>store.close());
  expect(()=>queueMemoryEdit(store,{...input,requestId:'not:queryable'},access)).toThrow('INVALID_SUBMISSION_ID');
  expect(store.pending()).toEqual([]);
});
