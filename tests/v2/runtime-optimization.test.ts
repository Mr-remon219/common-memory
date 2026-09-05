import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStore, type RuntimeOptions } from '../../src/v2/runtime.js';
const stores:RuntimeStore[]=[],roots:string[]=[];
function setup(options:RuntimeOptions={}) {const root=mkdtempSync(join(tmpdir(),'cm-perf-test-'));roots.push(root);const store=new RuntimeStore(root,options);stores.push(store);return store;}
function add(store:RuntimeStore,id:string,text='x',scope='global'){return store.enqueue({sessionId:'s',entryId:id,text,scope,source:'interactive',observedAt:new Date(0).toISOString()});}
afterEach(()=>{for(const store of stores.splice(0))store.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it.each(['中文','😀','a\0b','\ud800','\udc00'])('counts persisted UTF-8 bytes without truncation: %j',text=>{
 const cap=Buffer.byteLength(text)+1,store=setup({byteThreshold:cap,turnThreshold:100,idleMs:100000,maxWaitMs:100000});
 add(store,'a',text);expect(store.claim({maxTurns:1})).toBeNull();add(store,'b','x','project:a');
 const first=store.claim({maxTurns:1})!;expect(first.observations.map(o=>o.entryId)).toEqual(['a']);expect(Buffer.byteLength(first.observations[0]!.text!)).toBe(cap-1);
 store.finish(first);expect(store.pending().map(o=>o.entryId)).toEqual(['b']);
});
it('uses all pending scopes for count and consumes only the consecutive same-scope prefix',()=>{
 const store=setup({turnThreshold:3});add(store,'a','x');add(store,'b','x','project:p');add(store,'c','x');
 const first=store.claim({maxTurns:2})!;expect(first.observations.map(o=>o.entryId)).toEqual(['a']);store.finish(first);
 expect(store.claim({maxTurns:2})).toBeNull();store.requestFlush();const middle=store.claim({maxTurns:2})!;expect(middle.observations.map(o=>o.entryId)).toEqual(['b']);store.finish(middle);
 const last=store.claim({maxTurns:2})!;expect(last.observations.map(o=>o.entryId)).toEqual(['c']);store.finish(last);expect(store.claim()).toBeNull();
});
it('idle uses newest ID rather than maximum timestamp when the clock moves backwards',()=>{
 let now=1000;const store=setup({now:()=>now,turnThreshold:100,idleMs:100,maxWaitMs:10000});add(store,'first');now=0;add(store,'last');now=100;
 expect(store.claim()!.observations.map(o=>o.entryId)).toEqual(['first','last']);
});
it('oldest wait uses earliest ID rather than minimum timestamp',()=>{
 let now=1000;const store=setup({now:()=>now,turnThreshold:100,idleMs:10000,maxWaitMs:100});add(store,'first');now=0;add(store,'last');now=100;
 expect(store.claim()).toBeNull();now=1100;expect(store.claim()!.observations).toHaveLength(2);
});
it('accepts large explicit batch capacities and does not resize an already leased retry batch',()=>{
 let now=0;const store=setup({now:()=>now});add(store,'a');add(store,'b');const first=store.claim({force:true,maxTurns:Number.MAX_SAFE_INTEGER})!;
 expect(first.observations).toHaveLength(2);store.fail(first,new Error('TIMEOUT'));now=1000;const retried=store.claim({maxTurns:1})!;
 expect(retried.observations).toHaveLength(2);expect(retried.id).toBe(first.id);
});
it('pruning retains pending/quarantined and respects exact cutoff',()=>{
 let now=0;const store=setup({now:()=>now});const old=add(store,'old');store.finish(store.claim({force:true})!);
 now=100;store.pruneProcessed(100);expect(store.db.prepare('SELECT text FROM observations WHERE id=?').get(old.id)!.text).toBe('x');
 add(store,'pending');store.enqueue({sessionId:'s',entryId:'isolated',text:'kept',scope:'global',source:'extension',observedAt:new Date(0).toISOString()});
 now=101;store.pruneProcessed(100);expect(store.db.prepare('SELECT text FROM observations WHERE id=?').get(old.id)!.text).toBeNull();
 expect(store.db.prepare("SELECT text FROM observations WHERE entryId='pending'").get()!.text).toBe('x');expect(store.db.prepare("SELECT text FROM observations WHERE entryId='isolated'").get()!.text).toBe('kept');
});

it('does not repeatedly update already-pruned bodies',()=>{
 let now=0;const store=setup({now:()=>now});add(store,'old');store.finish(store.claim({force:true})!);now=1000;store.pruneProcessed(100);
 const before=Number(store.db.prepare('SELECT total_changes() AS n').get()!.n);store.pruneProcessed(100);
 expect(Number(store.db.prepare('SELECT total_changes() AS n').get()!.n)-before).toBe(0);
});
it('claim does not materialize the public unbounded pending list',()=>{
 const store=setup();for(let i=0;i<20;i++)add(store,String(i),'x'.repeat(4096));
 store.pending=()=>{throw new Error('unbounded read');};const job=store.claim({maxTurns:6})!;
 expect(job.observations.map(o=>o.entryId)).toEqual(['0','1','2','3','4','5']);
});

it('pruning uses the live-body partial index rather than scanning all processed history',()=>{
 const store=setup(),prepare=store.db.prepare.bind(store.db),queries:string[]=[];
 store.db.prepare=(sql:string)=>{queries.push(sql);return prepare(sql);};store.pruneProcessed();
 const sql=queries.find(q=>q.startsWith('UPDATE observations'))!;
 const plan=prepare(`EXPLAIN QUERY PLAN ${sql}`).all(0).map(row=>String(row.detail)).join('\n');
 expect(plan).toContain('observations_prunable');expect(plan).not.toContain('observations_state_id');
});
