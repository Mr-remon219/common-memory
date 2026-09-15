import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStore } from '../../src/v2/runtime.js';
import { RUNTIME_PROTOCOL } from '../../src/v2/upgrade.js';
import { openDatabase } from '../../src/v2/sqlite.js';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function legacyOne(){
 const root=mkdtempSync(join(tmpdir(),'cm-service-takeover-'));roots.push(root);const store=new RuntimeStore(root,{now:()=>1});
 store.enqueue({sessionId:'legacy-host',entryId:'user-turn',text:'Synthetic preference',scope:'global',source:'interactive',observedAt:'2026-09-01T00:00:00Z'});const job=store.claim()!;
 store.reserveRecovery(job);store.reserveRecovery(job);store.activity(job,'model_turn');store.activity(job,'model_turn');store.activity(job,'tool_call');
 const triggers=store.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'runtime_protocol_%'").all();
 for(const trigger of triggers)store.db.exec(`DROP TRIGGER "${String(trigger.name).replaceAll('"','""')}"`);
 store.db.exec('PRAGMA user_version=1');
 for(const trigger of triggers)store.db.exec(String(trigger.sql).replace(`common_memory_runtime_protocol()!=${RUNTIME_PROTOCOL}`,'common_memory_runtime_protocol()!=1'));
 store.db.exec('CREATE TRIGGER runtime_protocol_external_note AFTER UPDATE ON jobs BEGIN SELECT 1; END');store.close();
 const old=openDatabase(join(root,'runtime.sqlite'),{});old.function('common_memory_runtime_protocol',{deterministic:true},()=>1);
 return {root,job,old};
}
it('fences an already-prepared protocol-1 SELECT lease as well as mutations, preserving counters and unrelated triggers',()=>{
 const {root,job,old}=legacyOne();const check=old.prepare("SELECT id FROM jobs WHERE id=? AND token=? AND generation=? AND state='running' AND expires>?");
 expect(check.get(job.id,job.token,job.generation,2)).toBeDefined();const mutation=old.prepare('UPDATE jobs SET expires=expires+1 WHERE id=?');
 const store=new RuntimeStore(root,{now:()=>2});
 try{
  expect(check.get(job.id,job.token,job.generation,2)).toBeUndefined();expect(()=>mutation.run(job.id)).toThrow('INCOMPATIBLE_WRITER');
  expect(store.db.prepare('SELECT id,state,attempts,retries,modelTurns,toolCalls FROM jobs').get()).toMatchObject({id:job.id,state:'retry',attempts:1,retries:2,modelTurns:2,toolCalls:1});
  expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='runtime_protocol_external_note'").get()).toBeDefined();
  const next=store.claim()!;expect(next.id).toBe(job.id);expect(next.observations.map(o=>o.entryId)).toEqual(['user-turn']);expect(store.db.prepare('SELECT retries FROM jobs').get()!.retries).toBe(2);
 }finally{store.close();old.close();}
});
it('a conflicting managed trigger aborts takeover atomically rather than deleting arbitrary schema',()=>{
 const {root,job,old}=legacyOne();old.exec('DROP TRIGGER runtime_protocol_update; CREATE TRIGGER runtime_protocol_update AFTER UPDATE ON jobs BEGIN SELECT 1; END');
 try{expect(()=>new RuntimeStore(root,{now:()=>2})).toThrow('INCOMPATIBLE_RUNTIME_TRIGGER');expect(old.prepare('PRAGMA user_version').get()!.user_version).toBe(1);expect(old.prepare('SELECT id,token,generation,state FROM jobs').get()).toMatchObject({id:job.id,token:job.token,generation:job.generation,state:'running'});}finally{old.close();}
});
