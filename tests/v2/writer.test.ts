import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectRegistry } from '../../src/v2/registry.js';
import { createHash } from 'node:crypto';
import { Writer } from '../../src/v2/writer.js';
import type { ApprovedModelRequest, MemoryModelPort } from '../../src/memory-manager/contracts/model-port.js';
const roots:string[]=[];
function root() { const p=mkdtempSync(join(tmpdir(),'cm-writer-')); roots.push(p); return p; }
afterEach(()=>{for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
function model(decide:(r:ApprovedModelRequest)=>unknown):MemoryModelPort {return {async analyze(r){return {kind:'output',body:decide(r),usage:{inputTokens:100,outputTokens:20}};}};}
function body(r:ApprovedModelRequest,kind='retain',operations:unknown[]=[{op:'put_section',target:'preferences',section:null,title:'Language',body:'Prefers Chinese.\n'}]) {
  const observations=r.projection.observations as {ref:string}[];
  return {version:'memory_maintenance_v2',request_id:r.projection.request_id,decisions:[{kind,applicability:(operations[0] as {target?:string})?.target?.startsWith('project:')?'project':'global',confidence:0.2,evidence:[observations[0]!.ref],reason:'private model rationale',...(kind==='retain'?{admission:'remember',lifetime:'until_changed'}:{}),...(kind==='ignore'?{}:{operations})}]};
}
function enqueue(w:Writer,text='请用中文回答',id='e1'){w.store.enqueue({sessionId:'s',entryId:id,text,scope:'global',source:'interactive',observedAt:new Date().toISOString()});}
describe('V2 writer',()=>{
 it('retains without confidence threshold, updates and forgets without replay resurrection',async()=>{
  const path=root();let phase=0;
  const w=new Writer({dataRoot:path,allowedScopes:['global'],model:model(r=>body(r,phase===2?'forget':'retain',phase===2?[{op:'remove_section',target:'preferences',section:'s1'}]:[{op:'put_section',target:'preferences',section:phase===0?null:'s1',title:'Language',body:phase===0?'Prefers Chinese.':'Prefers English.'}]))});
  enqueue(w);expect(await w.run({force:true})).toEqual({outcome:'committed'});
  phase=1;enqueue(w,'改成英文','e2');expect((await w.run({force:true})).outcome).toBe('committed');expect(readFileSync(join(path,'memory/preferences.md'),'utf8')).not.toContain('Chinese');
  phase=2;enqueue(w,'忘记语言偏好','e3');expect((await w.run({force:true})).outcome).toBe('committed');expect(readFileSync(join(path,'memory/preferences.md'),'utf8')).not.toContain('Language');
  enqueue(w);expect((await w.run({force:true})).outcome).toBe('idle');expect(w.store.db.prepare('SELECT text FROM observations').all().every(o=>o.text===null)).toBe(true);
  for(const file of readdirSync(join(path,'runtime/receipts'))){const receipt=readFileSync(join(path,'runtime/receipts',file),'utf8');expect(receipt).not.toContain('private model rationale');expect(receipt).not.toContain('Prefers');}
  w.close();
 });
 it('recovers file success / DB rollback from immutable receipt, no second model call',async()=>{
  const path=root();let calls=0;const m=model(r=>{calls++;return body(r);});
  const w=new Writer({dataRoot:path,allowedScopes:['global'],model:m,checkpoint:()=>{throw new Error('crash');}});enqueue(w);await w.run({force:true});w.close();
  const next=new Writer({dataRoot:path,allowedScopes:['global'],model:m});expect((await next.run({force:true})).outcome).toBe('idle');expect(calls).toBe(1);expect(readFileSync(join(path,'memory/preferences.md'),'utf8')).toContain('Chinese');next.close();
 });
 it('consumes ignore and rejects malformed response without pollution',async()=>{
  const path=root();const w=new Writer({dataRoot:path,allowedScopes:['global'],model:model(r=>body(r,'ignore'))});enqueue(w);expect((await w.run({force:true})).outcome).toBe('ignored');expect((await w.run({force:true})).outcome).toBe('idle');w.close();
  const bad=new Writer({dataRoot:path,allowedScopes:['global'],model:model(()=>({oops:1}))});enqueue(bad,'new','e2');expect((await bad.run({force:true})).outcome).toBe('failed');expect(readdirSync(join(path,'memory'))).toEqual(['projects']);bad.close();
 });
 it('blocks secrets before network, isolates whole oversized turn',async()=>{
  let calls=0;const path=root();const w=new Writer({dataRoot:path,allowedScopes:['global'],maxRequestBytes:16000,model:model(r=>{calls++;return body(r);})});
  enqueue(w,'password=verysecret');expect((await w.run({force:true})).outcome).toBe('quarantined');enqueue(w,'x'.repeat(40000),'e2');expect((await w.run({force:true})).outcome).toBe('quarantined');expect(calls).toBe(0);expect(w.store.db.prepare('SELECT length(text) AS n FROM observations WHERE entryId=?').get('e2')!.n).toBe(40000);w.close();
 });
 it('detects human edits even for ignore; times out a model ignoring abort',async()=>{
  const path=root();const w=new Writer({dataRoot:path,allowedScopes:['global'],model:model(r=>{writeFileSync(join(path,'memory/profile.md'),'# Profile\n\n## Manual\nHuman\n');return body(r,'ignore');})});enqueue(w);expect((await w.run({force:true})).outcome).toBe('failed');expect(w.store.status().observations[0]!.state).not.toBe('processed');w.close();
  const timeout=new Writer({dataRoot:root(),allowedScopes:['global'],deadlineMs:20,model:{analyze:()=>new Promise(()=>{})}});enqueue(timeout);expect((await timeout.run({force:true})).outcome).toBe('cancelled');timeout.close();
 });
});

describe('batch, permission and output boundaries',()=>{
 it('shrinks oversized multi-turn requests without splitting turns or losing the FIFO tail',async()=>{
  const sizes:number[]=[];const w=new Writer({dataRoot:root(),allowedScopes:['global'],maxRequestBytes:18000,model:model(r=>{sizes.push((r.projection.observations as unknown[]).length);return body(r,'ignore');})});
  enqueue(w,'a'.repeat(5000),'a');enqueue(w,'b'.repeat(5000),'b');
  expect((await w.run({force:true})).outcome).toBe('ignored');expect(sizes).toEqual([1]);expect(w.store.pending().map(o=>o.entryId)).toEqual(['b']);expect((await w.run({force:true})).outcome).toBe('ignored');w.close();
 });
 it('never stores section title content in permanent receipts',async()=>{
  const path=root();let forget=false;const title='PersonalSensitiveTitle';const w=new Writer({dataRoot:path,allowedScopes:['global'],model:model(r=>body(r,forget?'forget':'retain',forget?[{op:'remove_section',target:'preferences',section:'s1'}]:[{op:'put_section',target:'preferences',section:null,title,body:'Value'}]))});
  enqueue(w);await w.run({force:true});forget=true;enqueue(w,'forget','f');await w.run({force:true});
  for(const file of readdirSync(join(path,'runtime/receipts')))expect(readFileSync(join(path,'runtime/receipts',file),'utf8')).not.toContain(title);w.close();
 });
 it.each(['wrong-evidence','wrong-request','path','secret','read-only'])('rejects %s without canonical side effects',async variant=>{
  const path=root();const w=new Writer({dataRoot:path,allowedScopes:['global'],...(variant==='read-only'?{writableScopes:[]}:{}),model:model(r=>{
   const result=body(r);if(variant==='wrong-evidence')result.decisions[0]!.evidence=['context_1'];if(variant==='wrong-request')result.request_id='wrong';
   if(variant==='path')result.decisions[0]!.operations=[{op:'put_section',target:'../../tmp/escape',section:null,title:'A',body:'B'}];
   if(variant==='secret')result.decisions[0]!.operations=[{op:'put_section',target:'profile',section:null,title:'A',body:'password=foo'}];return result;
  })});enqueue(w);expect((await w.run({force:true})).outcome).toBe('failed');expect(readdirSync(join(path,'runtime/receipts'))).toEqual([]);w.close();
 });
});


describe('scope and source recovery boundaries',()=>{
 it('allows authorized project-batch global maintain with empty evidence',async()=>{
  const path=root(),project=new ProjectRegistry(path).register(root(),'Project');
  const w=new Writer({dataRoot:path,allowedScopes:['global',`project:${project.id}`],model:model(r=>{const response=body(r,'maintain',[{op:'put_section',target:'preferences',section:'s1',title:'Language',body:'Prefers Chinese.\n'}]);response.decisions[0]!.evidence=[];return response;})});
  writeFileSync(join(path,'memory/preferences.md'),'# Preferences\n\n## Old language heading\nPrefers Chinese.\n');
  w.store.enqueue({sessionId:'s',entryId:'p',text:'Project status',scope:`project:${project.id}`,source:'interactive',observedAt:new Date().toISOString()});
  expect((await w.run({force:true})).outcome).toBe('committed');expect(readFileSync(join(path,'memory/preferences.md'),'utf8')).toContain('## Language');w.close();
 });
 it('does not spread unrelated decision sources, and partial forget retains other state',async()=>{
  const path=root();let phase=0;
  const w=new Writer({dataRoot:path,allowedScopes:['global'],model:model(r=>{
   if(phase===1)return body(r,'forget',[{op:'remove_section',target:'preferences',section:'s1'}]);
   const refs=(r.projection.observations as {ref:string}[]).map(o=>o.ref);
   return {version:'memory_maintenance_v2',request_id:r.projection.request_id,decisions:refs.map((ref,i)=>({kind:'retain',applicability:'global',confidence:1,evidence:[ref],reason:'state',admission:'remember',lifetime:'stable',operations:[{op:'put_section',target:'preferences',section:null,title:i?'B':'A',body:i?'other state':'forgotten state'}]}))};
  })});enqueue(w,'A','a');enqueue(w,'B','b');expect((await w.run({force:true})).outcome).toBe('committed');
  const key=(t:string)=>'preferences:'+createHash('sha256').update(t).digest('hex');expect(w.store.sources(key('A'))).toEqual([1]);expect(w.store.sources(key('B'))).toEqual([2]);
  phase=1;enqueue(w,'forget A','f');expect((await w.run({force:true})).outcome).toBe('committed');expect(w.store.sources(key('B'))).toEqual([2]);expect(w.store.db.prepare('SELECT text FROM observations WHERE id=2').get()!.text).toBe('B');expect(readFileSync(join(path,'memory/preferences.md'),'utf8')).toContain('other state');w.close();
 });
 it('fences a late model result at actual commit',async()=>{
  let now=0;const path=root();const w=new Writer({dataRoot:path,allowedScopes:['global'],scheduler:{now:()=>now,leaseMs:1000},model:model(r=>{now=1001;return body(r);})});enqueue(w);expect((await w.run({force:true})).outcome).toBe('failed');expect(readdirSync(join(path,'runtime/receipts'))).toEqual([]);w.close();
 });
});

it('two replacements in one decision do not exchange historical sources',async()=>{
 const path=root();let phase=0;
 const w=new Writer({dataRoot:path,allowedScopes:['global'],model:model(r=>{
  if(phase===2)return body(r,'forget',[{op:'remove_section',target:'preferences',section:'s1'}]);
  const operations=['A','B'].map((title,i)=>({op:'put_section',target:'preferences',section:phase===0?null:`s${i+1}`,title,body:`${title} current`}));
  if(phase===1)return body(r,'retain',operations);
  const refs=(r.projection.observations as {ref:string}[]).map(o=>o.ref);
  return {version:'memory_maintenance_v2',request_id:r.projection.request_id,decisions:operations.map((op,i)=>({kind:'retain',applicability:'global',confidence:1,evidence:[refs[i]],reason:'state',admission:'remember',lifetime:'stable',operations:[op]}))};
 })});
 enqueue(w,'old A','a');enqueue(w,'old B','b');expect((await w.run({force:true})).outcome).toBe('committed');
 phase=1;enqueue(w,'update both','u');expect((await w.run({force:true})).outcome).toBe('committed');
 const key=(t:string)=>'preferences:'+createHash('sha256').update(t).digest('hex');expect(w.store.sources(key('A'))).toEqual([1,3]);expect(w.store.sources(key('B'))).toEqual([2,3]);
 phase=2;enqueue(w,'forget A','f');expect((await w.run({force:true})).outcome).toBe('committed');expect(w.store.db.prepare('SELECT text FROM observations WHERE id=2').get()!.text).toBe('old B');w.close();
});

it('reconciles manual section rename before forget without retaining orphan bodies',async()=>{
 const path=root();let forget=false;const w=new Writer({dataRoot:path,allowedScopes:['global'],model:model(r=>body(r,forget?'forget':'retain',forget?[{op:'remove_section',target:'preferences',section:'s1'}]:[{op:'put_section',target:'preferences',section:null,title:'Language',body:'Chinese'}]))});
 enqueue(w,'original expression');expect((await w.run({force:true})).outcome).toBe('committed');writeFileSync(join(path,'memory/preferences.md'),'# Preferences\n\n## Languages\nChinese\n');
 forget=true;enqueue(w,'forget it','f');expect((await w.run({force:true})).outcome).toBe('committed');expect(w.store.db.prepare('SELECT text FROM observations WHERE id=1').get()!.text).toBeNull();expect(w.store.documentSourceKeys('preferences')).toEqual([]);w.close();
});

it('reconciles manual deletion even when forgetting returns already-consistent ignore',async()=>{
 const path=root();let ignore=false;const w=new Writer({dataRoot:path,allowedScopes:['global'],model:model(r=>body(r,ignore?'ignore':'retain'))});
 enqueue(w,'old expression');expect((await w.run({force:true})).outcome).toBe('committed');writeFileSync(join(path,'memory/preferences.md'),'# Preferences\n\n');
 ignore=true;enqueue(w,'forget deleted preference','f');expect((await w.run({force:true})).outcome).toBe('ignored');expect(w.store.db.prepare('SELECT text FROM observations WHERE id=1').get()!.text).toBeNull();expect(w.store.documentSourceKeys('preferences')).toEqual([]);expect(readdirSync(join(path,'runtime/receipts'))).toHaveLength(1);w.close();
});

it('revalidates project registration at commit after a concurrent removal',async()=>{
 const path=root(),registry=new ProjectRegistry(path),project=registry.register(root(),'Project');
 const scope=`project:${project.id}`;const w=new Writer({dataRoot:path,allowedScopes:['global',scope],model:model(r=>{registry.remove(project.id);return body(r,'retain',[{op:'put_section',target:scope,section:null,title:'State',body:'Ready'}]);})});
 w.store.enqueue({sessionId:'s',entryId:'p',text:'Project is ready',scope,source:'interactive',observedAt:new Date().toISOString()});
 expect((await w.run({force:true})).outcome).toBe('failed');expect(readdirSync(join(path,'runtime/receipts'))).toEqual([]);expect(w.store.db.prepare('SELECT state FROM observations').get()!.state).not.toBe('processed');w.close();
});

describe('project promotion',()=>{
 it.each([false,true])('promotes with explicit cleanup=%s, current sources and recoverable commit',async cleanup=>{
  const path=root(),registry=new ProjectRegistry(path),project=registry.register(root(),'A');
  const scope=`project:${project.id}`;let phase=0,calls=0;
  const w=new Writer({dataRoot:path,allowedScopes:['global',scope],checkpoint:()=>{if(phase===1)throw new Error('DB interruption');},model:model(r=>{
   calls++;
   const observations=r.projection.observations as {ref:string;source_scope:string;scope?:string}[];
   expect(observations[0]!.source_scope).toBe(scope);expect(observations[0]).not.toHaveProperty('scope');
   for(const context of r.projection.context_only as Record<string,unknown>[]){expect(context.source_scope).toBe(scope);expect(context).not.toHaveProperty('scope');expect(context).not.toHaveProperty('ref');}
   if(phase===0)return body(r,'retain',[{op:'put_section',target:scope,section:null,title:'Communication',body:'Prefers Chinese. Project release Friday.'}]);
   if(phase===2)return body(r,'forget',[{op:'remove_section',target:'preferences',section:'s1'}]);
   const response=body(r);
   if(cleanup)response.decisions.push({...response.decisions[0]!,kind:'maintain',applicability:'project',evidence:[],operations:[{op:'put_section',target:scope,section:'s1',title:'Communication',body:'Project release Friday.'}]});
   // retain-only fields are absent from the separate maintain decision.
   if(cleanup){delete response.decisions[1]!.admission;delete response.decisions[1]!.lifetime;}
   return response;
  })});
  const add=(entryId:string,text:string)=>w.store.enqueue({sessionId:'s',entryId,text,scope,source:'interactive',observedAt:new Date().toISOString()});
  try {
   add('old','Only this project: Chinese; release Friday');expect((await w.run({force:true})).outcome).toBe('committed');
   const before=w.canonical.snapshot([project.id]).find(d=>d.target===scope)!.content;
   phase=1;add('promotion','I prefer Chinese across all projects');expect((await w.run({force:true})).outcome).toBe('committed');
   expect(calls).toBe(2);expect((await w.run({force:true})).outcome).toBe('idle');
   const after=w.canonical.snapshot([project.id]).find(d=>d.target===scope)!.content;
   if(cleanup){expect(after).not.toContain('Prefers Chinese');expect(after).toContain('Project release Friday');}else expect(after).toBe(before);
   const key=(target:string,title:string)=>target+':'+createHash('sha256').update(title).digest('hex');
   expect(w.store.sources(key('preferences','Language'))).toEqual([2]);
   expect(w.store.sources(key(scope,'Communication'))).toEqual([1]);
   phase=2;add('forget','Forget my global language preference');expect((await w.run({force:true})).outcome).toBe('committed');
   expect(w.store.db.prepare('SELECT text FROM observations WHERE id=2').get()!.text).toBeNull();
   expect(w.store.db.prepare('SELECT text FROM observations WHERE id=1').get()!.text).not.toBeNull();
   expect(w.canonical.snapshot([project.id]).find(d=>d.target===scope)!.content).toBe(after);
  } finally {w.close();}
 });
 it.each(['undisclosed','read-only','other-project','stale','unregistered','lease'])('rejects promotion boundary: %s',async variant=>{
  const path=root(),registry=new ProjectRegistry(path),project=registry.register(root(),'A'),other=registry.register(root(),'B');
  const scope=`project:${project.id}`;let now=0;
  const w=new Writer({dataRoot:path,allowedScopes:variant==='undisclosed'?[scope]:['global',scope,`project:${other.id}`],writableScopes:variant==='read-only'?[scope]:['global',scope,`project:${other.id}`],scheduler:{now:()=>now,leaseMs:1000},model:model(r=>{
   if(variant==='stale')writeFileSync(join(path,'memory/profile.md'),'# Profile\n\n## Manual\nNew state\n');
   if(variant==='unregistered')registry.remove(project.id);
   if(variant==='lease')now=1001;
   return variant==='other-project'?body(r,'retain',[{op:'put_section',target:`project:${other.id}`,section:null,title:'A',body:'B'}]):body(r);
  })});
  try {
   w.store.enqueue({sessionId:'s',entryId:'p',text:'Global preference: Chinese',scope,source:'interactive',observedAt:new Date().toISOString()});
   expect((await w.run({force:true})).outcome).toBe('failed');expect(readdirSync(join(path,'runtime/receipts'))).toEqual([]);
   expect(w.canonical.snapshot([project.id]).find(d=>d.target==='preferences')!.sections).toEqual([]);
  } finally {w.close();}
 });
});

it.each([
 {text:'所有项目都用中文回答',applicability:'global',kind:'retain',admission:'remember',value:'Prefers Chinese.'},
 {text:'只在本项目用中文回答',applicability:'project',kind:'retain',admission:'remember',value:'This project: Chinese.'},
 {text:'也许中文吧',applicability:'uncertain',kind:'ignore',admission:'remember',value:''},
 {text:'这次请用中文',applicability:'project',kind:'ignore',admission:'remember',value:''},
 {text:'全局偏好补充：代码注释用英文',applicability:'global',kind:'retain',admission:'update',value:'Chinese responses; English code comments.'},
 {text:'纠正之前说法：全局仅解释用中文',applicability:'global',kind:'retain',admission:'correct',value:'Chinese explanations only.'},
 {text:'仅本项目例外，解释用英文',applicability:'project',kind:'retain',admission:'remember',value:'This project: English explanations.'},
])('executes scripted scope judgment without inferring semantics: $text',async fixture=>{
 const path=root(),project=new ProjectRegistry(path).register(root(),'A'),scope=`project:${project.id}`;
 const w=new Writer({dataRoot:path,allowedScopes:['global',scope],model:model(r=>{
  const target=fixture.applicability==='project'?scope:'preferences';
  const response=body(r,fixture.kind,[{op:'put_section',target,section:target==='preferences'?'s1':null,title:'Communication',body:fixture.value}]);
  response.decisions[0]!.applicability=fixture.applicability;
  if(fixture.kind==='retain')response.decisions[0]!.admission=fixture.admission;
  return response;
 })});
 try {
  writeFileSync(join(path,'memory/preferences.md'),'# Preferences\n\n## Communication\nOriginal global preference.\n');
  const before=w.canonical.snapshot([project.id]);
  w.store.enqueue({sessionId:'s',entryId:'p',text:fixture.text,scope,source:'interactive',observedAt:new Date().toISOString()});
  expect((await w.run({force:true})).outcome).toBe(fixture.kind==='ignore'?'ignored':'committed');
  const after=w.canonical.snapshot([project.id]);
  for(const doc of after){
   if(fixture.kind==='retain'&&doc.target===(fixture.applicability==='global'?'preferences':scope))expect(doc.content).toContain(fixture.value);
   else expect(doc.content).toBe(before.find(d=>d.target===doc.target)!.content);
  }
 } finally {w.close();}
});
