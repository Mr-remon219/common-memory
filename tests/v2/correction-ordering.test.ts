import {afterEach,expect,it} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Writer} from '../../src/v2/writer.js';
import {readTask} from '../helpers/decision-runtime.js';
import {tempRoots} from '../helpers/temp-roots.js';
const roots=tempRoots('cm-ordering-');afterEach(roots.cleanup);
function fixture(){
 let mode:'remember'|'correct'|'forget'|'ignore'='remember',value='Use A',calls=0;
 const root=roots.root();
 const writer=new Writer({dataRoot:root,allowedScopes:['global'],agent:{decide:async(task,reads)=>{
  calls++;const request=readTask(task,reads),evidence=(request.projection.observations as {ref:string}[]).map(o=>o.ref);
  const base={confidence:1,applicability:'global',evidence,reason:'synthetic'};
  const decision=mode==='ignore'?{...base,kind:'ignore'}:mode==='forget'?{...base,kind:'forget',operations:[{op:'remove_section',target:'preferences',section:'s1'}]}:{...base,kind:'retain',admission:mode,lifetime:'until_changed',operations:[{op:'put_section',target:'preferences',section:mode==='remember'?null:'s1',title:'Editor',body:value}]};
  return {body:{version:'memory_maintenance_v2',request_id:task.request_id,decisions:[decision]},usage:{},promptDigest:'a'.repeat(64)};
 }}});
 const add=(id:string,text:string,date='2026-09-01')=>writer.store.enqueue({sessionId:'synthetic',entryId:id,source:'interactive',scope:'global',text,observedAt:date+'T00:00:00Z'});
 return {writer,add,path:join(root,'memory/preferences.md'),set:(next:typeof mode,text=value)=>{mode=next;value=text;},calls:()=>calls};
}
it('normal conversational correction fences an older delivery arriving after the correction',async()=>{
 const f=fixture();try{
  f.add('first','Synthetic editor A');expect(await f.writer.run()).toEqual({outcome:'committed'});
  f.set('correct','Use B');f.add('correction','Actually use B','2026-09-03');expect(await f.writer.run()).toEqual({outcome:'committed'});
  f.set('correct','Use A');f.add('late','An older report of A','2026-09-02');expect(await f.writer.run()).toMatchObject({outcome:'failed',reason:'STALE_SOURCE'});
  expect(readFileSync(f.path,'utf8')).toContain('Use B');expect(readFileSync(f.path,'utf8')).not.toContain('Use A');expect(f.writer.store.db.prepare('SELECT COUNT(*) n FROM receipts').get()!.n).toBe(2);
 }finally{f.writer.close();}
});
it('forget rejects an exact replay with a new identity before another model disclosure',async()=>{
 const f=fixture();try{
  f.add('first','Synthetic editor A');await f.writer.run();f.set('forget');f.add('forget','Forget my editor','2026-09-03');expect(await f.writer.run()).toEqual({outcome:'committed'});
  expect(f.add('new-identity','Synthetic editor A').state).toBe('quarantined');expect(await f.writer.run()).toEqual({outcome:'idle'});expect(f.calls()).toBe(2);expect(readFileSync(f.path,'utf8')).not.toContain('Use A');
 }finally{f.writer.close();}
});
it('Core permits one bounded repair after the Agent confuses a snapshot with an ingest handle',async()=>{
 const writer=new Writer({dataRoot:roots.root(),allowedScopes:['global'],agent:{decide:async(task,reads,options)=>{
  expect(reads.processing().complete).toBe(false);
  try{reads.read(task.snapshot.handle,'profile');throw new Error('UNEXPECTED_READ_SUCCESS');}catch(error){expect(error).toMatchObject({message:'INVALID_BLOCK_REFERENCE'});expect(await options.recover!(error)).toBe(true);}
  expect(reads.processing().complete).toBe(false);
  const request=readTask(task,reads);expect(reads.processing().complete).toBe(true);
  return {body:{version:'memory_maintenance_v2',request_id:task.request_id,decisions:[{kind:'ignore',applicability:'global',confidence:1,evidence:(request.projection.observations as {ref:string}[]).map(o=>o.ref),reason:'Synthetic transient request'}]},usage:{},promptDigest:'a'.repeat(64)};
 }}});
 try{writer.store.enqueue({sessionId:'synthetic-repair',entryId:'one',source:'interactive',scope:'global',observedAt:'2026-09-14T00:00:00Z',text:'Synthetic transient request'});expect(await writer.run()).toEqual({outcome:'ignored'});expect(writer.store.status().jobs[0]).toMatchObject({automaticRecoveries:1,receiptVerified:true,state:'done',attempts:1});}finally{writer.close();}
});
it('manual Markdown formatting invalidates cached links, never invents a semantic forget',async()=>{
 const f=fixture();try{
  f.add('first','Synthetic editor A');await f.writer.run();writeFileSync(f.path,'# Preferences\n\n## Renamed editor\nUse A\n');
  f.set('ignore');f.add('unrelated','An unrelated expression','2026-09-03');expect(await f.writer.run()).toEqual({outcome:'ignored'});
  expect(f.writer.store.db.prepare('SELECT text FROM observations WHERE entryId=?').get('first')!.text).toBeNull();expect(f.writer.store.db.prepare('SELECT COUNT(*) n FROM forgotten_sources').get()!.n).toBe(0);expect(f.add('reaffirm','Synthetic editor A','2026-09-04').state).toBe('pending');expect(readFileSync(f.path,'utf8')).toContain('Use A');
 }finally{f.writer.close();}
});
