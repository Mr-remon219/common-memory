import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { RuntimeStore } from '../../src/v2/runtime.js';
import { MemoryModelError } from '../../src/memory-manager/contracts/errors.js';
import { McpIngress } from '../../src/mcp/ingress.js';
import { defaultConfig } from '../../src/config/config.js';
import { documentImportOutcome } from '../../src/v2/document-import.js';
const roots:string[]=[]; const stores:RuntimeStore[]=[];
function root(){const p=mkdtempSync(join(tmpdir(),'cm-diagnostic-'));roots.push(p);return p;}
function open(path:string, now=()=>100){const s=new RuntimeStore(path,{now,maxAttempts:2});stores.push(s);return s;}
function add(s:RuntimeStore){return s.enqueue({sessionId:'s',entryId:'e',source:'interactive',scope:'global',text:'private observation',observedAt:new Date(0).toISOString()});}
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
const diagnostic={stage:'http' as const,reason:'model_not_found' as const,httpStatus:404,retryable:false};
it('migrates an old database idempotently without changing jobs, evidence or receipts',()=>{
  const p=root(),db=new DatabaseSync(join(p,'runtime.sqlite'));
  db.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY,token TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL,available INTEGER NOT NULL,issue TEXT); INSERT INTO jobs VALUES('old','token',3,'done',100,2,200,'TIMEOUT')");db.close();
  const a=open(p),b=open(p);
  expect(b.db.prepare('PRAGMA table_info(jobs)').all().filter(r=>r.name==='diagnostic')).toHaveLength(1);
  expect(a.status().jobs).toEqual([{id:'old',state:'done',attempts:2,issue:'TIMEOUT',diagnostic:null,retryAt:null}]);
  expect(a.hasIncompleteWork()).toBe(false);add(a);const job=a.claim({force:true})!;expect(job).toBeTruthy();
});
it('persists only controlled diagnostics, reloads on restart, and hides history after success or retirement',()=>{
  const p=root();let now=100;let s=open(p,()=>now);add(s);const first=s.claim({force:true})!;
  s.fail(first,{code:'INVALID_RESPONSE',diagnostic:{...diagnostic,secret:'do-not-persist',message:'private-provider-text'}});
  const raw=String(s.db.prepare('SELECT diagnostic FROM jobs').get()!.diagnostic);expect(JSON.parse(raw)).toEqual(diagnostic);
  expect(raw).not.toContain('private');expect(raw).not.toContain('secret');
  stores.splice(stores.indexOf(s),1);s.close();s=open(p,()=>now);
  expect(s.observationOutcome('s','e')).toMatchObject({jobId:first.id,jobState:'retry',attempts:1,retryAt:1100,diagnostic,issue:'INVALID_RESPONSE'});
  now=1100;const next=s.claim({force:true})!;s.fail(next,new MemoryModelError('INVALID_RESPONSE','private text',false,diagnostic));
  expect(s.observationOutcome('s','e')).toMatchObject({state:'dead',attempts:2,retryAt:null,diagnostic});
  s.retry(first.id);expect(s.observationOutcome('s','e')).toMatchObject({state:'pending',jobId:null,diagnostic:null,issue:null,attempts:0});
  expect(s.status().jobs[0]).toMatchObject({state:'done',diagnostic});
  const last=s.claim({force:true})!;s.fail(last,new Error('TIMEOUT'));now+=1000;
  const retry=s.claim({force:true})!;s.finish(retry,{jobId:retry.id,observationIds:retry.observations.map(o=>o.id)});
  expect(s.observationOutcome('s','e')).toMatchObject({state:'processed',issue:null,diagnostic:null,retryAt:null,attempts:2});
  expect(s.status().jobs.at(-1)).toMatchObject({issue:'TIMEOUT',diagnostic:{reason:'timeout'}});expect(s.hasReceipt(retry.id)).toBe(true);
});
it('reads malformed or unknown legacy diagnostics as null and does not persist an arbitrary error',()=>{
  const s=open(root());add(s);const job=s.claim({force:true})!;s.fail(job,new Error('private arbitrary message'));
  expect(s.status().jobs[0]!.issue).toBe('VALIDATION_OR_STORAGE_FAILURE');
  for(const value of ['{oops','{"stage":"secret","reason":"secret","retryable":true}']){s.db.prepare('UPDATE jobs SET diagnostic=?').run(value);expect(s.observationOutcome('s','e')!.diagnostic).toBeNull();}
});
it.each(['relay','init'] as const)('MCP %s query follows only the current linked job and never returns bodies', mode=>{
  const p=root(),s=open(p),config=defaultConfig();config.dataRoot=p;config.disclosure.allowedProvenance=['user_explicit','agent_observation'];
  const ingress=new McpIngress(s,config,{clientId:'diag',capabilities:[mode],global:true,workspaces:[],accept:true});
  if(mode==='relay')ingress.submit({submissionId:'e',contextId:'global',text:'private data'});
  else ingress.init({importId:'e',contextId:'global',sourceLabel:'fixture',basis:'unknown',understanding:'private data'});
  const job=s.claim({force:true})!;s.fail(job,new MemoryModelError('INVALID_RESPONSE','private error',false,diagnostic));
  const result=mode==='relay'?ingress.status({submissionId:'e'}):ingress.initStatus('e');
  expect(result).toMatchObject({diagnostic,jobId:job.id,jobState:'retry',attempts:1});expect(JSON.stringify(result)).not.toContain('private');
});
it('Markdown part outcome includes current job diagnostics',()=>{
  const s=open(root());
  // Exercise the public import admission to preserve its identity convention.
  const p={importId:'md-test',contentDigest:'test',fileName:'fixture.md',sourceLabel:'fixture',declaredAuthor:'unknown' as const,bytes:1,chunks:[{entryId:'part-1',text:'x',headingPath:[],bytes:1}]};
  return import('../../src/v2/document-import.js').then(({admitDocumentImport})=>{
    admitDocumentImport(s,p,'global');const job=s.claim({force:true})!;s.fail(job,new MemoryModelError('INVALID_RESPONSE','private',false,diagnostic));
    expect(documentImportOutcome(s,'md-test','global',1)).toMatchObject({complete:false,parts:[{part:1,jobId:job.id,diagnostic,attempts:1,retryAt:1100}]});
  });
});

it('persists proxy authentication separately from provider status across restart',()=>{
  const p=root();let s=open(p);add(s);const job=s.claim({force:true})!;
  s.fail(job,{code:'PROXY_AUTHENTICATION',diagnostic:{stage:'network',reason:'proxy_authentication',proxyStatus:407,retryable:false,message:'password',proxyUrl:'http://user:secret@host'}});
  stores.splice(stores.indexOf(s),1);s.close();s=open(p);
  expect(s.observationOutcome('s','e')).toMatchObject({issue:'PROXY_AUTHENTICATION',diagnostic:{stage:'network',reason:'proxy_authentication',proxyStatus:407,retryable:false}});
  const raw=String(s.db.prepare('SELECT diagnostic FROM jobs').get()!.diagnostic);expect(raw).not.toMatch(/password|secret|proxyUrl|httpStatus/);
});
