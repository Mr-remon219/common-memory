import { afterEach, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempRoots } from '../helpers/temp-roots.js';
import { RuntimeStore } from '../../src/v2/runtime.js';
import { Writer } from '../../src/v2/writer.js';
import { structuralBlocks } from '../../src/v2/ingest.js';
import { encodeAgentImport } from '../../src/v2/import.js';
import { prepareDocumentImport, admitDocumentImport } from '../../src/v2/document-import.js';
import { SessionIngress } from '../../src/v2/session.js';
import type { MemoryTask, MemoryReadPort, MemoryAgentRuntime } from '../../src/core/contracts/memory-agent.js';
import { readTask } from '../helpers/decision-runtime.js';

const {root,cleanup}=tempRoots('cm-ingest-');
const close:(()=>void)[]=[];
afterEach(()=>{close.splice(0).reverse().forEach(f=>f());cleanup();});
const input=(text='x',entryId='e',source='interactive')=>({sessionId:'s',entryId,text,scope:'global',source,observedAt:'2026-09-13T00:00:00Z'});
const ignore=(task:MemoryTask)=>({body:{version:'memory_maintenance_v2',request_id:task.request_id,decisions:[{kind:'ignore',applicability:'uncertain',confidence:1,evidence:[],reason:'synthetic'}]},usage:{},promptDigest: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'});
function writer(decide:MemoryAgentRuntime['decide'],options:Partial<ConstructorParameters<typeof Writer>[0]>={}) {
  const w=new Writer({dataRoot:root(),allowedScopes:['global'],agent:{decide},...options});close.push(()=>w.close());return w;
}
it.each(['x','# Header\n\nParagraph\n\n> quote\n\n```md\n# not heading\n```\n','汉🙂'.repeat(90000)])('normalizes every input into persistent lossless structural ranges',text=>{
  const path=root();let store=new RuntimeStore(path);const observation=store.enqueue(input(text));
  const before=store.db.prepare('SELECT * FROM ingest_blocks ORDER BY ordinal').all();
  expect(before.length).toBeGreaterThan(0);expect(before.map(b=>text.slice(Number(b.start),Number(b.end))).join('')).toBe(text);
  expect(JSON.stringify(before)).not.toContain('Paragraph');
  const job=store.claim({force:true})!;store.close();store=new RuntimeStore(path);close.push(()=>store.close());
  expect(store.db.prepare('SELECT * FROM ingest_blocks ORDER BY ordinal').all()).toEqual(before);
  expect(store.enqueue(input(text)).id).toBe(observation.id);expect(store.status().jobs[0]!.id).toBe(job.id);
  expect(()=>store.enqueue(input(text+'different'))).toThrow('Conflicting observation identity');
});
it('preserves fenced headings, nested hierarchy, lists, tables and quotations without semantic labels',()=>{
  const text='# A\n\n## B\n\n> quote\n\n- item\n\n| table |\n\n```md\n## literal\n```';
  const blocks=structuralBlocks(text);expect(blocks.filter(b=>b.kind==='section')).toHaveLength(2);
  expect(blocks.filter(b=>b.kind==='section')[1]!.parent).toBe(blocks[0]!.id);
  expect(blocks.map(b=>b.kind)).toEqual(expect.arrayContaining(['quote','list','table','code']));
  expect(blocks.map(b=>text.slice(b.start,b.end)).join('')).toBe(text);
});
it('one large Markdown source has one bundle, many structural blocks, no legacy 256KiB rejection',()=>{
  const path=root(),file=join(path,'input.md');writeFileSync(file,'# Source\n\n'+('Paragraph.\n\n'.repeat(30000)));
  const prepared=prepareDocumentImport(file);expect(prepared.chunks).toHaveLength(1);
  const store=new RuntimeStore(path);close.push(()=>store.close());admitDocumentImport(store,prepared,'global');
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM ingest_bundles').get()!.n).toBe(1);
  expect(Number(store.db.prepare('SELECT COUNT(*) AS n FROM ingest_blocks').get()!.n)).toBeGreaterThan(30000);
});
it('backfills old queue states without changing IDs and purges ranges atomically without replay resurrection',()=>{
  const path=root(),original=input('before\0after');let store=new RuntimeStore(path);const o=store.enqueue(original);const job=store.claim({force:true})!;
  store.db.exec('DROP TRIGGER ingest_purge; DROP TABLE ingest_blocks; DROP TABLE ingest_bundles;');store.close();
  store=new RuntimeStore(path);close.push(()=>store.close());expect(store.status().jobs[0]!.id).toBe(job.id);
  expect(store.db.prepare('SELECT observationId FROM ingest_bundles').get()!.observationId).toBe(o.id);
  expect(store.db.prepare('SELECT end FROM ingest_blocks').get()!.end).toBe(original.text.length);
  const bytes=store.db.prepare('SELECT CAST(text AS BLOB) AS bytes FROM observations WHERE id=?').get(o.id)!.bytes as Uint8Array;expect(Buffer.from(bytes).toString('utf8')).toBe(original.text);
  store.finish(job,{jobId:job.id,observationIds:[o.id],forgetSourceIds:[o.id]});
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM ingest_blocks').get()!.n).toBe(0);
  expect(store.enqueue(original).text).toBeNull();expect(store.db.prepare('SELECT COUNT(*) AS n FROM ingest_blocks').get()!.n).toBe(0);
});
it('bootstrap contains only handles; pages are UTF8-safe, exhaustive, scoped and expire after decide',async()=>{
  const text='秘密不是凭据🙂汉'.repeat(10000);let captured:MemoryReadPort|undefined;
  const w=writer(async(task,reads)=>{
    captured=reads;expect(JSON.stringify(task)).not.toContain('秘密');
    const handle=task.bundles[0]!.ingest_id;
    expect(()=>reads.manifest('other')).toThrow('INVALID_INGEST_HANDLE');
    expect(()=>reads.memory('other')).toThrow('INVALID_SNAPSHOT_HANDLE');
    const block=reads.manifest(handle).blocks[0]!;
    expect(()=>reads.read(handle,block.block_id,100)).toThrow('NONCONTIGUOUS_READ');
    let result='';for(let offset:number|null=0;offset!==null;){const page=reads.read(handle,block.block_id,offset);expect(page.content).not.toContain('\ufffd');expect(page.descriptor).toEqual(block);result+=page.content;offset=page.next;}
    expect(result).toBe(text);expect(reads.processing().complete).toBe(true);return ignore(task);
  });w.store.enqueue(input(text));expect(await w.run({force:true})).toEqual({outcome:'ignored'});
  expect(()=>captured!.processing()).toThrow('EXPIRED_TASK');
});
it('even ignore cannot consume unread input; failed-attempt coverage is not reused',async()=>{
  let attempt=0,now=0;
  const w=writer(async(task,reads)=>{if(attempt++===0)reads.manifest(task.bundles[0]!.ingest_id);expect(reads.processing().read_bytes).toBe(0);return ignore(task);},{scheduler:{now:()=>now}});
  w.store.enqueue(input());expect(await w.run({force:true})).toMatchObject({outcome:'failed',reason:'INCOMPLETE_INGEST_COVERAGE'});
  now=1001;expect(await w.run({force:true})).toMatchObject({outcome:'failed'});expect(w.store.db.prepare('SELECT text,state FROM observations').get()).toEqual({text:'x',state:'claimed'});
});
it('requires reading imported gaps and current authorized context, and inspecting target before patches',async()=>{
  const w=writer(async(task,reads)=>{
    const handle=task.bundles[0]!.ingest_id;for(const b of reads.manifest(handle).blocks.filter(b=>!b.block_id.startsWith('gaps_')))reads.read(handle,b.block_id);
    expect(reads.processing().complete).toBe(false);return ignore(task);
  },{allowedProvenance:['agent_observation']});
  w.store.enqueue(input(encodeAgentImport({sourceLabel:'source',basis:'unknown',understanding:'Synthetic statement',gaps:'Only tentative'}),'e','agent_import'));
  expect((await w.run({force:true})).reason).toBe('INCOMPLETE_INGEST_COVERAGE');
  const edit=writer(async(task,reads)=>{for(const b of task.bundles)for(const block of reads.manifest(b.ingest_id).blocks)reads.read(b.ingest_id,block.block_id);return {...ignore(task),body:{version:'memory_maintenance_v2',request_id:task.request_id,decisions:[{kind:'retain',admission:'remember',lifetime:'stable',confidence:1,applicability:'global',evidence:['ev_1'],reason:'test',operations:[{op:'put_section',target:'profile',section:null,title:'X',body:'X'}]}]}};});
  edit.store.enqueue(input());expect((await edit.run({force:true})).reason).toBe('UNREAD_MEMORY_TARGET');
});
it.each([true,false])('current context has separate authorization and cannot be skipped when disclosed (%s)',async authorized=>{
  const w=writer(async(task,reads)=>{
    for(const bundle of task.bundles){const manifest=reads.manifest(bundle.ingest_id);for(const block of manifest.blocks){if(block.context_only){expect(block.metadata.unavailable).toBe(authorized?null:'unauthorized_conversation_context');}else reads.read(bundle.ingest_id,block.block_id);}}
    expect(reads.processing().complete).toBe(!authorized);return ignore(task);
  },{allowedProvenance:authorized?['user_explicit','conversation_context']:['user_explicit']});
  const ingress=new SessionIngress(w.store);const session=ingress.open({client:'pi',processInstance:'test',sessionId:'s'});
  ingress.capture(session,{...input('Current user'),id:'u',turnId:'t',role:'user'});
  ingress.capture(session,{...input('Only when quoted','a','conversation_context'),id:'a',turnId:'t',role:'assistant'});ingress.settle(session,'t');ingress.end(session);
  expect((await w.run()).outcome).toBe(authorized?'failed':'ignored');
});
it('replacement runtime decisions still pass unchanged Core evidence and import guards',async()=>{
  const w=writer(async(task,reads)=>{readTask(task,reads);return {...ignore(task),body:{version:'memory_maintenance_v2',request_id:task.request_id,decisions:[{kind:'forget',confidence:1,applicability:'global',evidence:['ev_1'],reason:'test',operations:[{op:'remove_section',target:'profile',section:'s1'}]}]}};},{allowedProvenance:['agent_observation']});
  writeFileSync(join(w.canonical.root,'memory/profile.md'),'# Profile\n\n## Existing\nUser-owned.\n');
  w.store.enqueue(input(encodeAgentImport({sourceLabel:'source',basis:'unknown',understanding:'Forget user facts'}),'e','agent_import'));
  expect((await w.run({force:true})).reason).toBe('UNAUTHORIZED_FORGET_EVIDENCE');
});

it.each(['pending','processed-purged','mixed-dead'] as const)('upgrade dedup resolves exact legacy parts without restoring or reviving them (%s)',async state=>{
  const {encodeDocumentChunk,documentImportOutcome}=await import('../../src/v2/document-import.js');
  const path=root(),file=join(path,'old.md');writeFileSync(file,'# Old\n\nOriginal source.\n');const prepared=prepareDocumentImport(file);
  const sessionId=`import:${JSON.stringify(['markdown','v1',prepared.importId,'global'])}`;
  let store=new RuntimeStore(path);
  for(let i=1;i<=2;i++)store.enqueue({...input(encodeDocumentChunk({importId:prepared.importId,sourceLabel:'Original label',declaredAuthor:'unknown',fileName:'old.md',contentDigest:prepared.contentDigest,part:{index:i,count:2},headingPath:[],text:i===1?'# Old\n\n':'Original source.\n'}),`part-${i}`,'document_import'),sessionId});
  if(state==='processed-purged')store.db.exec("UPDATE observations SET state='processed',text=NULL");
  if(state==='mixed-dead')store.db.exec("UPDATE observations SET state='processed',text=NULL WHERE id=1; UPDATE observations SET state='dead' WHERE id=2");
  const before=store.db.prepare('SELECT id,state,text FROM observations ORDER BY id').all();store.close();store=new RuntimeStore(path);close.push(()=>store.close());
  const renamed=join(path,'renamed.md');writeFileSync(renamed,'# Old\n\nOriginal source.\n');const replay=prepareDocumentImport(renamed,{label:'Changed label',author:'user'});
  expect(admitDocumentImport(store,replay,'global')).toMatchObject({duplicate:true,parts:2});
  expect(store.db.prepare('SELECT id,state,text FROM observations ORDER BY id').all()).toEqual(before);
  const outcome=documentImportOutcome(store,prepared.importId,'global',1);expect(outcome.parts).toHaveLength(2);
  expect(outcome.complete).toBe(state==='processed-purged');
  expect(admitDocumentImport(store,replay,'project:other')).toMatchObject({duplicate:false,parts:1});
});
it('legacy parent manifests describe only the claimed subset and never consume another part',async()=>{
  const {encodeDocumentChunk}=await import('../../src/v2/document-import.js');
  const w=writer(async(task,reads)=>{
    expect(task.bundles).toHaveLength(1);expect(task.bundles[0]).toMatchObject({legacy_subset:true,original_part_count:2});
    expect(reads.manifest(task.bundles[0]!.ingest_id).blocks[0]!.kind).toBe('document_part');readTask(task,reads);return ignore(task);
  },{scheduler:{turnThreshold:1},allowedProvenance:['document_import']});
  for(let i=1;i<=2;i++)w.store.enqueue(input(encodeDocumentChunk({importId:'md-test',sourceLabel:'old',declaredAuthor:'unknown',fileName:'old.md',contentDigest:'test',part:{index:i,count:2},headingPath:[],text:`Part ${i}`}),`part-${i}`,'document_import'));
  expect((await w.run({force:true})).outcome).toBe('ignored');expect(w.store.pending().map(o=>o.entryId)).toEqual(['part-2']);
});
it.each(['legacy','session'] as const)('explicit input cap trims complete %s groups instead of quarantining individually fitting inputs',async kind=>{
 const seen:string[][]=[],contexts:string[]=[];
 const w=writer(async(task,reads)=>{const r=readTask(task,reads);seen.push((r.projection.observations as {text:string}[]).map(o=>o.text));contexts.push(JSON.stringify(r.projection.context_only));return ignore(task);},{maxRequestBytes:20000,allowedProvenance:['user_explicit','conversation_context']});
 if(kind==='legacy')for(const id of ['a','b'])w.store.enqueue(input(id.repeat(11000),id));
 else {const ingress=new SessionIngress(w.store),key=ingress.open({client:'pi',processInstance:'p',sessionId:'cap'});
  for(const id of ['a','b']){ingress.capture(key,{...input(id.repeat(11000)),id,turnId:id,role:'user'});ingress.capture(key,{...input('confirm '+id),id:id+'-steer',turnId:id,role:'user'});ingress.capture(key,{...input('qualifier '+id,'e','conversation_context'),id:id+'-context',turnId:id,role:'assistant'});ingress.settle(key,id);}ingress.end(key);}
 expect(await w.run({force:true})).toEqual({outcome:'ignored'});
 expect(seen).toEqual([kind==='legacy'?['a'.repeat(11000)]:['a'.repeat(11000),'confirm a']]);
 expect(w.store.pending().map(o=>o.text)).toEqual(kind==='legacy'?['b'.repeat(11000)]:['b'.repeat(11000),'confirm b']);
 if(kind==='session'){expect(contexts[0]).toContain('qualifier a');expect(contexts[0]).not.toContain('qualifier b');}
 expect(await w.run({force:true})).toEqual({outcome:'ignored'});expect(w.store.pending()).toEqual([]);
 expect(w.store.status().observations).toEqual([{state:'processed',count:kind==='legacy'?2:4}]);
 if(kind==='session'){expect(contexts[1]).toContain('qualifier b');expect(contexts[1]).not.toContain('qualifier a');}
});
it.each(['legacy','session'] as const)('optional previous %s context is dropped before any current source is trimmed',async kind=>{
 const seen:{count:number;context:string}[]=[];
 const w=writer(async(task,reads)=>{const r=readTask(task,reads);seen.push({count:(r.projection.observations as unknown[]).length,context:JSON.stringify(r.projection.context_only)});return ignore(task);},{maxRequestBytes:20000,allowedProvenance:['user_explicit','conversation_context']});
 if(kind==='legacy') {
  w.store.enqueue(input('old-marker'+'x'.repeat(15000),'last-old'));expect(await w.run({force:true})).toEqual({outcome:'ignored'});
  w.store.enqueue(input('a'.repeat(5500),'new-a'));w.store.enqueue(input('b'.repeat(5500),'new-b'));expect(await w.run({force:true})).toEqual({outcome:'ignored'});
 } else {
  const ingress=new SessionIngress(w.store),key=ingress.open({client:'pi',processInstance:'p',sessionId:'prior-cap'});
  for(let i=0;i<9;i++){const id='old-'+i;ingress.capture(key,{...input('prior',id),id,turnId:id,role:'user'});ingress.settle(key,id);}
  ingress.capture(key,{...input('old-marker'+'x'.repeat(15000),'last-old'),id:'last-old',turnId:'last-old',role:'user'});ingress.settle(key,'last-old');
  for(let i=0;i<10;i++)expect(await w.run({force:true})).toEqual({outcome:'ignored'});
  ingress.capture(key,{...input('a'.repeat(5500),'new-a'),id:'new-a',turnId:'new',role:'user'});ingress.capture(key,{...input('b'.repeat(5500),'new-b'),id:'new-b',turnId:'new',role:'user'});ingress.settle(key,'new');ingress.end(key);
  expect(await w.run({force:true})).toEqual({outcome:'ignored'});
 }
 expect(seen.at(-1)).toEqual({count:2,context:'[]'});expect(w.store.pending()).toEqual([]);expect(w.store.status().observations.some(o=>o.state==='quarantined')).toBe(false);
});
it('shared ingest parser preserves inline backticks, blank lines, heading titles and scoped qualifiers',()=>{
 const text='\n\n# C#\n\n```js``` is inline, not a fence\n\n\nOnly on weekends: '+ 'x'.repeat(40000)+'\n\n## Tail\n\n> hypothetical\n';
 const blocks=structuralBlocks(text);expect(blocks.map(b=>text.slice(b.start,b.end)).join('')).toBe(text);
 expect(blocks.filter(b=>b.kind==='section')).toHaveLength(2);expect(blocks.some(b=>b.kind==='code')).toBe(false);
 const headings=blocks.filter(b=>b.kind==='section');expect(headings[1]!.parent).toBe(headings[0]!.id);
 expect(text.slice(headings[0]!.start,headings[0]!.end)).toBe('# C#\n');
});
it('receipt usage cannot retain provider prose or unknown fields from the Runtime',async()=>{
 const w=writer(async(task,reads)=>{readTask(task,reads);return {...ignore(task),usage:{inputTokens:'RAW_PROVIDER_BODY',outputTokens:3,totalTokens:Infinity,raw:'RAW_PROVIDER_BODY'} as never,body:{version:'memory_maintenance_v2',request_id:task.request_id,decisions:[{kind:'retain',admission:'remember',lifetime:'stable',confidence:1,applicability:'global',evidence:['ev_1'],reason:'x',operations:[{op:'put_section',target:'profile',section:null,title:'Test',body:'Synthetic.'}]}]}};});
 w.store.enqueue(input());expect(await w.run({force:true})).toEqual({outcome:'committed'});
 const {readFileSync,readdirSync}=await import('node:fs');const dir=join(w.canonical.root,'runtime/receipts');
 const receipt=JSON.parse(readFileSync(join(dir,readdirSync(dir)[0]!),'utf8'));expect(receipt.usage).toEqual({outputTokens:3});expect(JSON.stringify(receipt)).not.toContain('RAW_PROVIDER_BODY');
});
it.each([undefined,null,17,'PRIVATE_RUNTIME_TRANSCRIPT'.repeat(1000),'A'.repeat(64),'a'.repeat(63),'a'.repeat(65)])('rejects noncanonical runtime prompt identity before consuming ignore or writing receipts (case %#)',async promptDigest=>{
 for(const mutate of [false,true]) {
  const w=writer(async(task,reads)=>{readTask(task,reads);return {...ignore(task),promptDigest:promptDigest as never,...(mutate?{body:{version:'memory_maintenance_v2',request_id:task.request_id,decisions:[{kind:'retain',admission:'remember',lifetime:'stable',confidence:1,applicability:'global',evidence:['ev_1'],reason:'x',operations:[{op:'put_section',target:'profile',section:null,title:'Test',body:'Synthetic.'}]}]}}:{})};});
  w.store.enqueue(input());expect(await w.run({force:true})).toEqual({outcome:'failed',reason:'INVALID_PROMPT_DIGEST'});
  expect(w.store.status().jobs[0]).toMatchObject({state:'dead',issue:'INVALID_PROMPT_DIGEST',diagnostic:{stage:'core_validation',reason:'core_rejected'}});
  expect(w.store.db.prepare('SELECT state,text FROM observations').get()).toEqual({state:'dead',text:'x'});
  expect(w.store.db.prepare('SELECT COUNT(*) AS n FROM receipts').get()!.n).toBe(0);
  const {readdirSync}=await import('node:fs');expect(readdirSync(join(w.canonical.root,'runtime/receipts'))).toEqual([]);expect(w.canonical.snapshot().every(d=>!d.sections.length)).toBe(true);
 }
});
it('directly addressed source pages always disclose complete authoritative descriptors, including import qualifiers',async()=>{
 const w=writer(async(task,reads)=>{
  const handle=task.bundles[0]!.ingest_id;
  const first=reads.read(handle,'text_0'); // deliberately no manifest call
  expect(first.descriptor).toMatchObject({block_id:'text_0',parent_id:null,kind:'paragraph',context_only:false,evidence_ref:'ev_1',metadata:{source:'agent_import',source_kind:'agent_import',source_label:'quoted-source',basis:'unknown',scope:'global',provenance:'agent_observation'}});
  expect(reads.processing().complete).toBe(false); // gap/qualification is a separate required source block
  const gap=reads.read(handle,'gaps_0');expect(gap.content).toBe('Only provisional; no older sources.');expect(gap.descriptor.metadata).toEqual(first.descriptor.metadata);
  (first.descriptor.metadata as Record<string,unknown>).source_label='forged';
  expect(reads.read(handle,'text_0').descriptor.metadata.source_label).toBe('quoted-source');expect(reads.processing().complete).toBe(true);return ignore(task);
 },{allowedProvenance:['agent_observation']});
 w.store.enqueue(input(encodeAgentImport({sourceLabel:'quoted-source',basis:'unknown',understanding:'Quoted understanding.',gaps:'Only provisional; no older sources.'}),'e','agent_import'));
 expect(await w.run({force:true})).toEqual({outcome:'ignored'});
});
it('session context capture atomically persists shared structure without observations or plaintext copies',()=>{
 const store=new RuntimeStore(root());close.push(()=>store.close());const ingress=new SessionIngress(store),key=ingress.open({client:'pi',processInstance:'p',sessionId:'structure'});
 ingress.capture(key,{...input('User'),id:'u',turnId:'t',role:'user'});
 const text="# Qualifier\n\n> Only during review\n\n```md\n## Not a heading\n```\n";
 for(const role of ['assistant','tool'] as const)ingress.capture(key,{...input(text,role,'conversation_context'),id:role,turnId:'t',role});
 expect(store.db.prepare('SELECT COUNT(*) AS n FROM observations').get()!.n).toBe(1);
 const bundles=store.db.prepare('SELECT * FROM session_ingest_bundles').all();expect(bundles).toHaveLength(2);
 for(const bundle of bundles){const blocks=store.db.prepare('SELECT * FROM session_ingest_blocks WHERE bundleId=? ORDER BY ordinal').all(bundle.id!);expect(blocks[0]).toMatchObject({id:'conversation',kind:'conversation',start:0,end:0});expect(blocks.filter(b=>b.kind==='section')).toHaveLength(1);expect(blocks.map(b=>b.kind)).toEqual(expect.arrayContaining(['quote','code']));expect(blocks.map(b=>text.slice(Number(b.start),Number(b.end))).join('')).toBe(text);expect(JSON.stringify(blocks)).not.toContain('Qualifier');}
 const before=store.db.prepare('SELECT COUNT(*) AS n FROM session_messages').get()!.n;
 expect(()=>new SessionIngress(store,{maxSessionBytes:1}).capture(key,{...input('capacity refused','late','conversation_context'),id:'late',turnId:'t',role:'assistant'})).toThrow('SESSION_CAPACITY_EXCEEDED');
 expect(store.db.prepare('SELECT COUNT(*) AS n FROM session_messages').get()!.n).toBe(before);expect(store.db.prepare('SELECT COUNT(*) AS n FROM session_ingest_bundles').get()!.n).toBe(2);
});
it('context backfill is atomic and NUL/null preserving; stable owner identities never revive unavailable bodies',()=>{
 const path=root();let store=new RuntimeStore(path);const ingress=new SessionIngress(store),key=ingress.open({client:'pi',processInstance:'p',sessionId:'upgrade'});
 ingress.capture(key,{...input('User'),id:'u',turnId:'t',role:'user'});
 const messages=['nul','null','last'].map(id=>({...input('Original '+id,id,'conversation_context'),id,turnId:'t',role:'assistant' as const}));for(const m of messages)ingress.capture(key,m);
 store.db.prepare("UPDATE session_messages SET text=? WHERE messageId='nul'").run('before\0after');store.db.exec("UPDATE session_messages SET text=NULL,unavailable='source_unavailable' WHERE messageId='null'; DELETE FROM session_ingest_blocks; DELETE FROM session_ingest_bundles;");
 const last=Number(store.db.prepare("SELECT id FROM session_messages WHERE messageId='last'").get()!.id);
 store.db.exec(`CREATE TRIGGER reject_context_backfill BEFORE INSERT ON session_ingest_blocks WHEN NEW.bundleId='session_ingest_${last}' BEGIN SELECT RAISE(ABORT,'synthetic interruption'); END;`);
 expect(()=>new RuntimeStore(path)).toThrow('synthetic interruption');expect(store.db.prepare('SELECT COUNT(*) AS n FROM session_ingest_bundles').get()!.n).toBe(0);expect(store.db.prepare('SELECT COUNT(*) AS n FROM session_ingest_blocks').get()!.n).toBe(0);
 store.db.exec('DROP TRIGGER reject_context_backfill');store.close();store=new RuntimeStore(path);
 const before=store.db.prepare('SELECT * FROM session_ingest_bundles ORDER BY messageId').all();expect(before).toHaveLength(3);
 const nul=Number(store.db.prepare("SELECT id FROM session_messages WHERE messageId='nul'").get()!.id);
 expect(store.db.prepare("SELECT end FROM session_ingest_blocks WHERE bundleId=? AND id='text_0'").get(`session_ingest_${nul}`)!.end).toBe('before\0after'.length);
 const missing=Number(store.db.prepare("SELECT id FROM session_messages WHERE messageId='null'").get()!.id);expect(store.db.prepare('SELECT COUNT(*) AS n FROM session_ingest_blocks WHERE bundleId=?').get(`session_ingest_${missing}`)!.n).toBe(0);
 new SessionIngress(store).capture(key,messages[1]!);expect(store.db.prepare("SELECT text FROM session_messages WHERE messageId='null'").get()!.text).toBeNull();
 store.close();store=new RuntimeStore(path);close.push(()=>store.close());expect(store.db.prepare('SELECT * FROM session_ingest_bundles ORDER BY messageId').all()).toEqual(before);
 store.db.exec("UPDATE session_messages SET unavailable='sensitive_context' WHERE messageId='last'");expect(store.db.prepare('SELECT COUNT(*) AS n FROM session_ingest_blocks WHERE bundleId=?').get(`session_ingest_${last}`)!.n).toBe(0);
 store.db.exec('UPDATE observations SET text=NULL');expect(store.db.prepare('SELECT COUNT(*) AS n FROM session_ingest_blocks').get()!.n).toBe(0);expect(store.db.prepare("SELECT COUNT(*) AS n FROM session_messages WHERE role!='user' AND text IS NOT NULL").get()!.n).toBe(0);
});
it('persistent current context handles and structural metadata survive retry without becoming evidence',async()=>{
 let now=0,complete=false;const handles:string[][]=[];
 const w=writer(async(task,reads)=>{
  expect(JSON.stringify(task)).not.toContain('Quoted condition');const context=task.bundles.filter(b=>b.source==='conversation_context');handles.push(context.map(b=>b.ingest_id));
  for(const bundle of task.bundles){if(bundle.source!=='conversation_context')reads.read(bundle.ingest_id,'text_0');else {
   const page=reads.read(bundle.ingest_id,'text_0');expect(page.descriptor).toMatchObject({kind:'section',parent_id:'conversation',context_only:true,metadata:{role:'assistant',provenance:'conversation_context',message_id:'a',message_order:2,turn_id:'t',previous_turn:false}});expect(page.descriptor.evidence_ref).toBeUndefined();
  }}
  if(complete)readTask(task,reads);else expect(reads.processing().complete).toBe(false);return ignore(task);
 },{allowedProvenance:['user_explicit','conversation_context'],scheduler:{now:()=>now}});
 const ingress=new SessionIngress(w.store),key=ingress.open({client:'pi',processInstance:'p',sessionId:'retry-context'});
 ingress.capture(key,{...input('User'),id:'u',turnId:'t',role:'user'});ingress.capture(key,{...input('# Quoted condition\n\n> Only during review\n','a','conversation_context'),id:'a',turnId:'t',role:'assistant'});ingress.settle(key,'t');ingress.end(key);
 expect(await w.run()).toMatchObject({outcome:'failed',reason:'INCOMPLETE_INGEST_COVERAGE'});now=1001;complete=true;expect(await w.run()).toEqual({outcome:'ignored'});expect(handles[0]).toEqual(handles[1]);expect(handles[0]![0]).toMatch(/^session_ingest_/);
 w.store.pruneProcessed(1); // fake processing time is old relative to this store's configured clock only after advancing it
 now=1003;w.store.pruneProcessed(1);expect(w.store.db.prepare('SELECT COUNT(*) AS n FROM session_ingest_blocks').get()!.n).toBe(0);
});
