import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStore } from '../../src/v2/runtime.js';
import { openDatabase } from '../../src/v2/sqlite.js';
import { initializeRuntime, RUNTIME_PROTOCOL } from '../../src/v2/upgrade.js';
import { MemoryModelError } from '../../src/core/contracts/errors.js';
const roots:string[]=[];
const root=()=>{const r=mkdtempSync(join(tmpdir(),'cm-reliability-'));roots.push(r);return r;};
afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
const add=(s:RuntimeStore,id='one')=>s.enqueue({sessionId:'synthetic',entryId:id,text:'Synthetic preference',scope:'global',source:'interactive',observedAt:'2026-09-01T00:00:00Z'});
const network=()=>new MemoryModelError('UNAVAILABLE','not persisted',true,{stage:'network',reason:'network_error',retryable:true});
function legacy(path:string,active=false) {
 const s=new RuntimeStore(path,{now:()=>0});add(s);const job=s.claim({force:true})!;
 for(const row of s.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'runtime_protocol_%'").all())s.db.exec(`DROP TRIGGER "${String(row.name).replaceAll('"','""')}"`);
 s.db.exec('PRAGMA user_version=0;');
 if(!active)s.db.prepare("UPDATE jobs SET state='retry',attempts=3 WHERE id=?").run(job.id);
 for(const column of ['retries','modelTurns','toolCalls','configurationVersion'])s.db.exec(`ALTER TABLE jobs DROP COLUMN ${column}`);
 s.close();return job;
}
it('migrates a legacy durable job once, takes a usable data backup and fences an unaware old writer',()=>{
 const path=root(),job=legacy(path);mkdirSync(join(path,'memory'),{recursive:true});writeFileSync(join(path,'memory/preferences.md'),'# Preferences\n\n');
 const s=new RuntimeStore(path,{now:()=>1000});
 try {
  expect(s.db.prepare('PRAGMA user_version').get()!.user_version).toBe(RUNTIME_PROTOCOL);
  expect(s.db.prepare('SELECT id,attempts,retries FROM jobs').get()).toMatchObject({id:job.id,attempts:3,retries:2});
  const backups=readdirSync(join(path,'runtime/upgrade-backups'));expect(backups).toHaveLength(1);
  const backup=join(path,'runtime/upgrade-backups',backups[0]!);expect(readFileSync(join(backup,'memory/preferences.md'),'utf8')).toBe('# Preferences\n\n');
  const snapshot=openDatabase(join(backup,'runtime.sqlite'),{readOnly:true});try{expect(snapshot.prepare('SELECT COUNT(*) n FROM observations').get()!.n).toBe(1);}finally{snapshot.close();}
  const old=openDatabase(join(path,'runtime.sqlite'),{});try{expect(()=>old.prepare("UPDATE jobs SET state='running' WHERE id=?").run(job.id)).toThrow('common_memory_runtime_protocol');expect(()=>old.prepare("INSERT INTO observations(sessionId,entryId,text,digest,scope,observedAt,source,state,enqueuedAt) VALUES('old','replay','Synthetic preference','digest','global','2026-09-01','interactive','pending',0)").run()).toThrow('common_memory_runtime_protocol');}finally{old.close();}
 } finally{s.close();}
 const again=new RuntimeStore(path);again.close();expect(readdirSync(join(path,'runtime/upgrade-backups'))).toHaveLength(1);
});
it.each(['rpc','mcp_user_submission','codex_user_delivery'])('preserves pruned user digest for %s when migrating deletion history',source=>{
 const path=root();legacy(path);const old=openDatabase(join(path,'runtime.sqlite'),{});
 try{old.exec("ALTER TABLE observations DROP COLUMN contentDigest; UPDATE jobs SET state='done';");old.prepare("UPDATE observations SET state='processed',text=NULL,source=?").run(source);}finally{old.close();}
 const s=new RuntimeStore(path);try{const row=s.db.prepare('SELECT id,digest,contentDigest FROM observations').get()!;expect(row.contentDigest).toBe(row.digest);s.enqueue({sessionId:'forget',entryId:'one',text:'Forget synthetic preference',scope:'global',source:'interactive',observedAt:new Date().toISOString()});const job=s.claim()!;s.finish(job,{jobId:job.id,observationIds:job.observations.map(o=>o.id),forgetSourceIds:[Number(row.id)]});expect(add(s,'replay').state).toBe('quarantined');}finally{s.close();}
});
it('does not let one exhausted task declare the entire model configuration unavailable',()=>{
 const s=new RuntimeStore(root());try{add(s);const a=s.claim()!;s.configureTask(a,'v');s.fail(a,new Error('AGENT_TURN_LIMIT'));expect(s.blockedConfiguration('v')).toBeNull();add(s,'small');expect(s.claim()!.observations[0]!.entryId).toBe('small');}finally{s.close();}
});
it('takes over an active legacy lease without losing source identity or restoring its budget',()=>{
 const path=root(),job=legacy(path,true),store=new RuntimeStore(path,{now:()=>1});
 try{expect(store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(RUNTIME_PROTOCOL);expect(store.db.prepare('SELECT text FROM observations').get()!.text).toBe('Synthetic preference');expect(store.db.prepare('SELECT id,state,attempts,retries FROM jobs').get()).toMatchObject({id:job.id,state:'retry',attempts:1,retries:0});expect(()=>store.assertLease(job)).toThrow();expect(store.claim()!.id).toBe(job.id);}finally{store.close();}
});
it('interrupted migration rolls back schema and preserves the original job for retry',()=>{
 const path=root(),job=legacy(path),db=openDatabase(join(path,'runtime.sqlite'),{});
 try{expect(()=>initializeRuntime(db,path,1000,()=>{db.exec('CREATE TABLE interrupted(value TEXT)');throw new Error('synthetic interruption');})).toThrow('synthetic interruption');expect(db.prepare("SELECT name FROM sqlite_master WHERE name='interrupted'").get()).toBeUndefined();expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(0);}finally{db.close();}
 const s=new RuntimeStore(path,{now:()=>1000});try{expect(s.claim({force:true})!.id).toBe(job.id);}finally{s.close();}
});
it('allows initial plus five automatic retries across reopen, never multiplies or resets the budget',()=>{
 const path=root();let now=0,s=new RuntimeStore(path,{now:()=>now});add(s);let id='';
 for(let attempt=0;attempt<6;attempt++){
  const job=s.claim({force:true})!;expect(job).not.toBeNull();if(!id)id=job.id;expect(job.id).toBe(id);s.fail(job,network());
  expect(s.db.prepare('SELECT retries FROM jobs').get()!.retries).toBe(Math.min(attempt+1,5));
  s.close();now+=600_000;s=new RuntimeStore(path,{now:()=>now});
 }
 try{expect(s.status().jobs[0]).toMatchObject({state:'paused',attempts:6});expect(s.claim({force:true})).toBeNull();s.retry(id);const job=s.claim({force:true})!;expect(job.id).toBe(id);expect(s.reserveRecovery(job)).toBeNull();}finally{s.close();}
});
it('shares reservations with queue failure recovery and fences a spent reservation after crash',()=>{
 const path=root();let now=0,s=new RuntimeStore(path,{now:()=>now});add(s);let job=s.claim({force:true})!;
 expect(s.reserveRecovery(job)).toBe(1);s.activity(job,'model_turn',2);s.activity(job,'tool_call');s.close();now=200_000;s=new RuntimeStore(path,{now:()=>now});
 try{job=s.claim({force:true})!;expect(s.reserveRecovery(job)).toBe(3);s.activity(job,'model_turn',2);expect(()=>s.activity(job,'model_turn',2)).toThrow('AGENT_TURN_LIMIT');s.fail(job,network());expect(s.db.prepare('SELECT retries,modelTurns,toolCalls FROM jobs').get()).toMatchObject({retries:4,modelTurns:2,toolCalls:1});}finally{s.close();}
});
it('does not grant an unbounded budget to repeated expired leases',()=>{
 const path=root();let now=0,s=new RuntimeStore(path,{now:()=>now,leaseMs:1});add(s);let id='';
 try{for(let n=0;n<6;n++){const job=s.claim()!;expect(job).not.toBeNull();id ||= job.id;expect(job.id).toBe(id);s.close();now++;s=new RuntimeStore(path,{now:()=>now,leaseMs:1});}expect(s.claim()).toBeNull();expect(s.status().jobs[0]).toMatchObject({state:'paused',attempts:6,issue:'RECOVERY_BUDGET_EXHAUSTED'});expect(s.db.prepare('SELECT retries FROM jobs').get()!.retries).toBe(5);}finally{s.close();}
});
it('bypasses unrelated backoff only when write authority proves scopes independent',()=>{
 const path=root();let now=0;const s=new RuntimeStore(path,{now:()=>now});
 const enqueue=(id:string,scope:string)=>s.enqueue({sessionId:'s',entryId:id,text:'Synthetic',scope,source:'interactive',observedAt:new Date(0).toISOString()});
 try{enqueue('older','project:a');const a=s.claim({globalWrites:false})!;s.fail(a,network());enqueue('same-target','project:a');enqueue('other-target','project:b');expect(s.claim()).toBeNull();const b=s.claim({globalWrites:false})!;expect(b.observations.map(o=>o.entryId)).toEqual(['other-target']);s.finish(b);expect(s.claim({globalWrites:false})).toBeNull();now=1000;expect(s.claim({globalWrites:false})!.id).toBe(a.id);}finally{s.close();}
});
it('configuration repair spends one automatic recovery; auth failure and explicit stop themselves spend none',()=>{
 const path=root(),s=new RuntimeStore(path);add(s);let job=s.claim({force:true})!;s.configureTask(job,'old');
 try{s.fail(job,new MemoryModelError('AUTHENTICATION','redacted',false));expect(s.db.prepare('SELECT retries FROM jobs').get()!.retries).toBe(0);s.resumeConfiguration('old');expect(s.claim({force:true})).toBeNull();s.resumeConfiguration('new');const id=job.id;job=s.claim({force:true})!;expect(job.id).toBe(id);s.fail(job,new Error('CANCELLED'));s.resumeConfiguration('newer');expect(s.claim({force:true})).toBeNull();expect(s.db.prepare('SELECT retries FROM jobs').get()!.retries).toBe(1);}finally{s.close();}
});
