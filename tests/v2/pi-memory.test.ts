import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { initTheme, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getKeybindings, visibleWidth, type Component } from '@earendil-works/pi-tui';
import { tempRoots } from '../helpers/temp-roots.js';
import { readTask } from '../helpers/decision-runtime.js';
import { defaultConfig } from '../../src/config/config.js';
import { RuntimeStore } from '../../src/v2/runtime.js';
import { Writer } from '../../src/v2/writer.js';
import { ProjectRegistry } from '../../src/v2/registry.js';
import { PiMemoryService } from '../../src/pi-extension/memory-service.js';
import { createCommonMemoryPiExtension } from '../../src/pi-extension/index.js';
import { PiCaptureRuntime } from '../../src/pi-extension/extraction-runtime.js';
import { MemoryViewer, openMemoryPanel } from '../../src/pi-extension/memory-ui.js';

const roots=tempRoots('cm-pi-native-');const close:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const fn of close.splice(0))await fn();vi.useRealTimers();vi.restoreAllMocks();roots.cleanup();});
function fixture(open=false){
  const root=roots.root(),config=defaultConfig({COMMON_MEMORY_HOME:root});
  const store=open?new RuntimeStore(config.dataRoot):undefined;if(store)close.push(()=>store.close());
  const wake=vi.fn();const service=new PiMemoryService({config:()=>config,activeStore:()=>store?{dataRoot:config.dataRoot,store}:undefined,wake});
  const host={cwd:root,sessionId:'session'};return {root,config,store,service,host,wake};
}
const imported={importId:'original',contextId:'global',sourceLabel:'prior-agent',basis:'unknown' as const,understanding:'Only during Rust review, prefers concise comments.',gaps:'No evidence about other work.'};
it('read/discovery work without a key or database; a human may browse authorized projects without expanding model scope',()=>{
  const {root,config,service,host}=fixture();const other=join(root,'other');mkdirSync(other);
  const project=new ProjectRegistry(config.dataRoot).register(other,'Other');config.disclosure.allowedScopes=[...config.disclosure.allowedScopes,`project:${project.id}`];
  mkdirSync(join(config.dataRoot,'memory/projects'),{recursive:true});writeFileSync(join(config.dataRoot,'memory/projects',`${project.id}.md`),'# Other\n\n## Note\nPRIVATE_OTHER');
  expect(service.contexts(host).map(c=>c.id)).toEqual(['global']);
  expect(service.read(host).documents).toHaveLength(2);
  expect(()=>service.read(host,`project:${project.id}`)).toThrow('CONTEXT_UNAVAILABLE');
  expect(service.read(host,`project:${project.id}`,true).documents[0]!.content).toContain('PRIVATE_OTHER');
  expect(service.status(host)).toMatchObject({initEnabled:false,readEnabled:true});
  expect(existsSync(join(config.dataRoot,'runtime.sqlite'))).toBe(false);
  config.disclosure.allowedScopes=['global'];expect(()=>service.read(host,`project:${project.id}`,true)).toThrow('CONTEXT_UNAVAILABLE');
});
it('native Init uses structural Core ingress, stable session identity and exact replay across reopen',()=>{
  const {config,service,host}=fixture();config.disclosure.allowedProvenance=[...config.disclosure.allowedProvenance,'agent_observation'];
  expect(service.import(host,imported)).toMatchObject({accepted:true,duplicate:false,next:{arguments:{importId:'original'}}});
  expect(service.import(host,imported)).toMatchObject({duplicate:true});
  expect(()=>service.import(host,{...imported,understanding:'changed'})).toThrow('SUBMISSION_CONFLICT');
  const store=new RuntimeStore(config.dataRoot);try{
    const rows=store.db.prepare('SELECT source,text FROM observations').all();expect(rows).toHaveLength(1);expect(rows[0]!.source).toBe('agent_import');expect(rows[0]!.text).toContain(imported.gaps);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM ingest_blocks').get()!.n).toBe(2);
  }finally{store.close();}
  expect(service.status(host,{importId:'original'})).toMatchObject({item:{state:'pending'}});
  expect(service.status({...host,sessionId:'other'},{importId:'original'})).toMatchObject({item:null});
});
it.each(['permission','scope','size','cancel'])('denies native import %s without admitting material',reason=>{
  const {config,service,host}=fixture();config.disclosure.allowedProvenance=[...config.disclosure.allowedProvenance,'agent_observation'];const signal=new AbortController();
  if(reason==='permission')config.disclosure.allowedProvenance=[];
  if(reason==='scope')config.disclosure.allowedScopes=[];
  if(reason==='size')config.disclosure.maxTotalBytes=1;
  if(reason==='cancel')signal.abort();
  expect(()=>service.import(host,imported,signal.signal)).toThrow();
  if(existsSync(join(config.dataRoot,'runtime.sqlite'))){const s=new RuntimeStore(config.dataRoot);try{expect(s.status().observations).toEqual([]);}finally{s.close();}}
});
it('an accepted explicit adjustment ID remains queryable unchanged, while colon IDs are rejected',()=>{
  const {service,host,store}=fixture(true);const requestId='edit_original-1';
  const accepted=service.adjust(host,'global','A complete editing request.',requestId);
  expect(accepted).toMatchObject({accepted:true,requestId,next:{arguments:{requestId}}});
  expect(service.status(host,{requestId})).toMatchObject({item:{state:'pending'},next:{arguments:{requestId}}});
  expect(service.adjust(host,'global','A complete editing request.',requestId)).toMatchObject({duplicate:true,requestId});
  expect(()=>service.adjust(host,'global','Another request.','not:queryable')).toThrow('INVALID_SUBMISSION_ID');
  expect(store!.pending()).toHaveLength(1);
});
it('bounds recent requests without truncating aggregate unfinished counts',()=>{
  const {service,host,store}=fixture(true);
  for(let i=0;i<25;i++)service.adjust(host,'global',`Complete editing request ${i}.`,`edit-${i}`);
  const status=service.status(host);
  expect('recent' in status && status.recent).toHaveLength(20);
  if(!('recent' in status))throw new Error('missing recent status');
  expect(status.recent.map(row=>row.requestId)).toEqual(Array.from({length:20},(_,i)=>`edit-${24-i}`));
  expect(status.queue.observations).toContainEqual({state:'pending',count:25});
  expect(store!.db.prepare("SELECT COUNT(*) AS n FROM observations WHERE state='pending'").get()!.n).toBe(25);
  for(let i=0;i<25;i++){const job=store!.claim({force:true})!;store!.db.prepare("UPDATE jobs SET state='dead' WHERE id=?").run(job.id);store!.db.prepare("UPDATE observations SET state='dead' WHERE jobId=?").run(job.id);}
  const failed=service.status(host);if(!('recent' in failed))throw new Error('missing failed status');
  expect(failed.recent).toHaveLength(20);expect(failed.queue.jobs).toHaveLength(20);
  expect(failed.queue.observations).toContainEqual({state:'dead',count:25});expect(failed.queue.jobStates).toContainEqual({state:'dead',count:25});
});
it('prompt adjustment is verbatim user evidence, with Core retain/correct/forget and observable outcomes',async()=>{
  const {config,service,host}=fixture();let phase=0;
  const writer=new Writer({dataRoot:config.dataRoot,allowedScopes:['global'],writableScopes:['global'],allowedProvenance:['user_explicit'],agent:{decide:async(task,reads)=>{
    const projection=readTask(task,reads).projection as {observations:{ref:string;text:string}[];documents:{target:string;sections:{ref:string}[]}[]};
    expect(projection.observations[0]!.text).toBe(['  Only during review: use A.\n','Replace A with B, only during review.','Forget that review preference.'][phase]);
    const section=projection.documents.find(d=>d.target==='preferences')!.sections[0]?.ref??null;
    const decision=phase===2?{kind:'forget',operations:[{op:'remove_section',target:'preferences',section}]}:{kind:'retain',admission:phase?'correct':'remember',lifetime:'stable',operations:[{op:'put_section',target:'preferences',section,title:'Review',body:phase?'During review, use B.':'During review, use A.'}]};
    return {body:{edit_result:'modified',version:'memory_maintenance_v2',request_id:task.request_id,decisions:[{...decision,applicability:'global',confidence:1,evidence:projection.observations.map(o=>o.ref),reason:'synthetic'}]},usage:{},promptDigest:'a'.repeat(64)};
  }}});close.push(()=>writer.close());
  for(const prompt of ['  Only during review: use A.\n','Replace A with B, only during review.','Forget that review preference.']){
    const accepted=service.adjust(host,'global',prompt);expect(accepted.next.action).toBe('poll');
    expect(service.status(host,{requestId:accepted.requestId})).toMatchObject({item:{state:'pending'}});
    expect(await writer.run({force:true})).toMatchObject({outcome:'committed'});
    expect(service.status(host,{requestId:accepted.requestId})).toMatchObject({item:{state:'processed',editResult:'modified'},next:{action:'read'}});phase++;
  }
  expect(readFileSync(join(config.dataRoot,'memory/preferences.md'),'utf8')).not.toContain('## Review');
});
it.each(['read','write','provenance','empty','secret','size'])('adjustment refuses %s before queue creation',reason=>{
  const {config,service,host}=fixture();let prompt='Complete condition.';
  if(reason==='read')config.disclosure.allowedScopes=[];if(reason==='write')config.writableScopes=[];if(reason==='provenance')config.disclosure.allowedProvenance=[];
  if(reason==='empty')prompt=' ';if(reason==='secret')prompt='password=verysecret';if(reason==='size')config.disclosure.maxTotalBytes=1;
  expect(()=>service.adjust(host,'global',prompt)).toThrow();expect(existsSync(join(config.dataRoot,'runtime.sqlite'))).toBe(false);
});
it('body-free scoped status cannot disclose/retry a partly unauthorized job or reset automatic backoff',()=>{
  const {config,store:s,service,host}=fixture(true);const store=s!;
  const accepted=service.adjust(host,'global','SENSITIVE_TO_STATUS_NOT_A_SECRET');const job=store.claim({force:true})!;store.fail(job,new Error('UNAVAILABLE'));
  expect(()=>service.retry(host,job.id)).toThrow('RETRY_UNAVAILABLE');
  expect(JSON.stringify(service.status(host))).not.toContain('SENSITIVE_TO_STATUS_NOT_A_SECRET');
  store.db.prepare("UPDATE jobs SET state='dead' WHERE id=?").run(job.id);store.db.prepare("UPDATE observations SET state='dead' WHERE jobId=?").run(job.id);
  config.disclosure.allowedProvenance=[];expect(()=>service.retry(host,job.id)).toThrow('RETRY_UNAVAILABLE');config.disclosure.allowedProvenance=['user_explicit'];
  store.enqueue({sessionId:'other',entryId:'one',scope:'project:hidden',text:'PRIVATE',source:'interactive',observedAt:new Date().toISOString()});store.db.prepare("UPDATE observations SET jobId=?,state='dead' WHERE sessionId='other'").run(job.id);
  expect(JSON.stringify(service.status(host))).not.toContain('PRIVATE');expect(()=>service.retry(host,job.id)).toThrow('RETRY_UNAVAILABLE');
  // Hidden material is excluded from the general queue view; item identity stays scope-gated too.
  config.disclosure.allowedScopes=[];expect(service.status(host,{requestId:accepted.requestId})).toMatchObject({item:null});
});
function extension(config:ReturnType<typeof defaultConfig>,runtime?:PiCaptureRuntime){
  const handlers=new Map<string,(e:any,c:any)=>any>(),tools=new Map<string,any>(),commands=new Map<string,any>();
  const pi={on:(n:string,f:any)=>handlers.set(n,f),registerTool:(t:any)=>tools.set(t.name,t),registerCommand:(n:string,c:any)=>commands.set(n,c),sendMessage:vi.fn(),appendEntry:vi.fn()} as unknown as ExtensionAPI;
  createCommonMemoryPiExtension({configFactory:()=>config,...(runtime?{runtimeFactory:()=>runtime}:{})})(pi);
  const ctx={cwd:join(config.dataRoot,'..'),mode:'tui',hasUI:true,hasPendingMessages:()=>false,sessionManager:{getSessionId:()=>'native',getBranch:()=>[],getLeafId:()=>null},ui:{confirm:vi.fn(async()=>false),setStatus:vi.fn(),notify:vi.fn()}} as unknown as ExtensionContext;
  return {handlers,tools,commands,pi,ctx};
}
it('native import needs actual UI confirmation; noninteractive, denial, cancellation and permission changes cannot enqueue',async()=>{
  const {config}=fixture();config.disclosure.allowedProvenance=[...config.disclosure.allowedProvenance,'agent_observation'];const h=extension(config),tool=h.tools.get('memory_init');
  await expect(tool.execute('t',imported,undefined,undefined,{...h.ctx,hasUI:false})).rejects.toThrow('IMPORT_CONFIRMATION_REQUIRED');
  await expect(tool.execute('t',imported,undefined,undefined,h.ctx)).rejects.toThrow('CANCELLED');
  vi.mocked(h.ctx.ui.confirm).mockImplementation(async()=>{config.disclosure.allowedProvenance=[];return true;});
  await expect(tool.execute('t',imported,undefined,undefined,h.ctx)).rejects.toThrow('INIT_DISABLED');
  config.disclosure.allowedProvenance=['agent_observation'];vi.mocked(h.ctx.ui.confirm).mockResolvedValue(true);
  const accepted=await tool.execute('t',imported,undefined,undefined,h.ctx);expect(accepted.details).toMatchObject({accepted:true,importId:'original'});
  const outcome=await h.tools.get('memory_status').execute('s',{importId:'original'},undefined,undefined,h.ctx);expect(outcome.details.item.state).toBe('pending');
});
it('pending import confirmation cannot submit into a replaced/reloaded session',async()=>{
  const {config}=fixture();config.disclosure.allowedProvenance=[...config.disclosure.allowedProvenance,'agent_observation'];const h=extension(config);
  vi.mocked(h.ctx.ui.confirm).mockImplementation(async()=>{await h.handlers.get('session_shutdown')!({reason:'reload'},h.ctx);return true;});
  await expect(h.tools.get('memory_init').execute('t',imported,undefined,undefined,h.ctx)).rejects.toThrow('CANCELLED');expect(existsSync(join(config.dataRoot,'runtime.sqlite'))).toBe(false);
});
it('frozen injection and native read both stop exposing revoked scope; regrant does not revive the discarded snapshot',()=>{
  const {config}=fixture();mkdirSync(join(config.dataRoot,'memory'),{recursive:true});writeFileSync(join(config.dataRoot,'memory/profile.md'),'# Profile\n\n## Entry\nPRIVATE_PROFILE');const h=extension(config);
  const before=()=>h.handlers.get('before_agent_start')!({systemPrompt:'BASE'},h.ctx).systemPrompt;
  expect(before()).toContain('PRIVATE_PROFILE');config.disclosure.allowedScopes=[];expect(before()).not.toContain('PRIVATE_PROFILE');config.disclosure.allowedScopes=['global'];expect(before()).not.toContain('PRIVATE_PROFILE');
});
it('new nested-project resolution discards the former project snapshot without auto-reading the new project',async()=>{
  const {root,config}=fixture();const nested=join(root,'nested');mkdirSync(nested);
  const registry=new ProjectRegistry(config.dataRoot),a=registry.register(root,'Parent');
  config.disclosure.allowedScopes=['global',`project:${a.id}`];
  mkdirSync(join(config.dataRoot,'memory/projects'),{recursive:true});writeFileSync(join(config.dataRoot,'memory/projects',`${a.id}.md`),'# Parent\n\n## Note\nPARENT_PRIVATE');
  const h=extension(config),ctx={...h.ctx,cwd:nested};const before=()=>h.handlers.get('before_agent_start')!({systemPrompt:'BASE'},ctx).systemPrompt;
  expect(before()).toContain('PARENT_PRIVATE');
  const b=registry.register(nested,'Nested');config.disclosure.allowedScopes=[...config.disclosure.allowedScopes,`project:${b.id}`];
  writeFileSync(join(config.dataRoot,'memory/projects',`${b.id}.md`),'# Nested\n\n## Note\nNESTED_PRIVATE');
  expect(before()).not.toContain('PARENT_PRIVATE');expect(before()).not.toContain('NESTED_PRIVATE');
  const result=await h.tools.get('memory_read').execute('r',{},undefined,undefined,ctx);expect(JSON.stringify(result)).toContain('NESTED_PRIVATE');
});
it('human cross-project outcome stays visible without recommending an unauthorized model read',()=>{
  const {root,config,store,service,host}=fixture(true);const other=join(root,'other');mkdirSync(other);const p=new ProjectRegistry(config.dataRoot).register(other,'Other'),scope=`project:${p.id}`;
  config.disclosure.allowedScopes=['global',scope];config.writableScopes=['global',scope];
  const request=service.adjust(host,scope,'Other project correction.');
  store!.db.prepare("UPDATE observations SET state='processed' WHERE entryId=?").run(request.requestId);
  const id=store!.db.prepare('SELECT id FROM observations WHERE entryId=?').get(request.requestId)!.id!;
  store!.db.prepare('INSERT INTO associations VALUES(?,?)').run(scope,id);
  expect(service.status(host,{requestId:request.requestId},true)).toMatchObject({item:{state:'processed',retainedIn:[scope]},next:{action:'review'}});
  const all=service.status(host,{},true);expect('recent' in all && all.recent[0]!.next.tool).toBeUndefined();
  expect(service.status(host,{requestId:request.requestId})).toMatchObject({item:null});
  expect(()=>service.read(host,scope)).toThrow('CONTEXT_UNAVAILABLE');
});
it('authorized failed work retries with its original body; import-only continuation does not require capture permission',()=>{
  const {config,store:s,service,host,wake}=fixture(true),store=s!;
  const request=service.adjust(host,'global','Preserve this complete qualifier.');const job=store.claim({force:true})!;
  store.db.prepare("UPDATE jobs SET state='dead' WHERE id=?").run(job.id);store.db.prepare("UPDATE observations SET state='dead' WHERE jobId=?").run(job.id);
  service.retry(host,job.id);expect(service.status(host,{requestId:request.requestId})).toMatchObject({item:{state:'pending'}});
  expect(store.db.prepare('SELECT text FROM observations').get()!.text).toBe('Preserve this complete qualifier.');
  config.disclosure.allowedProvenance=['agent_observation'];service.import(host,imported);expect(service.flush()).toBe(true);expect(wake).toHaveBeenCalled();
});
it('native feedback observes background state without adding messages or leaking raw diagnostics, and stops on shutdown',async()=>{
  vi.useFakeTimers();const {config,store:s}=fixture(true),store=s!;
  const runtime=new PiCaptureRuntime({store,run:async()=>({outcome:'idle'}),close:()=>{}});close.unshift(()=>runtime.shutdown());const h=extension(config,runtime);
  await h.handlers.get('session_start')!({reason:'startup'},h.ctx);
  store.enqueue({sessionId:'x',entryId:'e',scope:'global',source:'interactive',text:'private body',observedAt:new Date().toISOString()});const job=store.claim({force:true})!;store.fail(job,new Error('UNAVAILABLE'));
  store.db.prepare("UPDATE jobs SET state='dead',diagnostic=? WHERE id=?").run(JSON.stringify({stage:'model_request',reason:'unavailable',retryable:true,raw:'secret'}),job.id);store.db.prepare("UPDATE observations SET state='dead' WHERE jobId=?").run(job.id);
  await vi.advanceTimersByTimeAsync(5000);expect(h.ctx.ui.notify).toHaveBeenCalledTimes(1);expect(JSON.stringify(vi.mocked(h.ctx.ui.setStatus).mock.calls)).not.toContain('private body');expect(h.pi.sendMessage).not.toHaveBeenCalled();expect(h.pi.appendEntry).not.toHaveBeenCalled();
  await h.handlers.get('session_shutdown')!({reason:'reload'},h.ctx);const n=vi.mocked(h.ctx.ui.setStatus).mock.calls.length;await vi.advanceTimersByTimeAsync(5000);expect(h.ctx.ui.setStatus).toHaveBeenCalledTimes(n);
});

it('settings-style memory page opens document subpages, scrolls to the full tail and returns without model messages',async()=>{
  initTheme('dark',false);const {config,service,host}=fixture();mkdirSync(join(config.dataRoot,'memory'),{recursive:true});const path=join(config.dataRoot,'memory/profile.md');writeFileSync(path,'# Profile\n\n## Notes\n'+Array.from({length:80},(_,n)=>`Row ${n}\n`).join('')+'FINAL_QUALIFIER');
  let calls=0;const ctx={cwd:host.cwd,mode:'tui',hasUI:true,sessionManager:{getSessionId:()=>host.sessionId},ui:{notify:vi.fn(),custom:async(factory:any)=>new Promise(resolve=>{
    calls++;const component:Component=factory({terminal:{rows:24},requestRender:()=>{}},{fg:(_c:string,s:string)=>s,bold:(s:string)=>s},getKeybindings(),resolve);
    const render=()=>component.render(60).join('\n');expect(render()).toContain('Profile');expect(render()).toContain('Preferences');expect(render()).toContain('调整记忆');
    component.handleInput!('\r');expect(render()).toContain('Row 0');component.handleInput!('\x1b[F');expect(render()).toContain('FINAL_QUALIFIER');
    // Permission is rechecked even while the body subpage is open.
    config.disclosure.allowedScopes=[];expect(render()).not.toContain('FINAL_QUALIFIER');expect(render()).toContain('CONTEXT_UNAVAILABLE');
    component.handleInput!('\x1b');component.handleInput!('\x1b');
  })}} as unknown as ExtensionCommandContext;
  await openMemoryPanel(ctx,service,()=>{},()=>{});expect(calls).toBe(1);expect(ctx.ui.notify).not.toHaveBeenCalled();
});
it('viewer handles narrow widths, control codes, Unicode and reflow without losing the full tail',()=>{
  initTheme('dark',false);const viewer=new MemoryViewer(()=>`# 名称\n\n${'边界说明 '.repeat(100)}\nTAIL\u001b[31m`,()=>16,getKeybindings(),()=>{});
  for(const width of [12,40,80]){viewer.handleInput('\x1b[F');const lines=viewer.render(width);expect(lines.every(l=>visibleWidth(l)<=width)).toBe(true);expect(lines.join('\n')).toContain('TAIL');}
});
it.each([false,true])('prompt adjustment uses confirmed user text and refuses stale pages (session replaced: %s)',async replaced=>{
  initTheme('dark',false);const {service,host,config}=fixture();let step=0,active=true;
  const ctx={cwd:host.cwd,mode:'tui',hasUI:true,sessionManager:{getSessionId:()=>host.sessionId},ui:{notify:vi.fn(),editor:vi.fn(async()=> '  Only during review: replace A with B.\n'),confirm:vi.fn(async()=>{if(replaced)active=false;return true;}),custom:async(factory:any)=>new Promise(resolve=>{
    const component:Component=factory({terminal:{rows:24},requestRender:()=>{}},{fg:(_c:string,s:string)=>s,bold:(s:string)=>s},getKeybindings(),resolve);
    if(step===0){component.handleInput!('调整记忆');component.handleInput!('\r');}
    else if(step===1)component.handleInput!('\r');
    else component.handleInput!('\x1b');step++;
  })}} as unknown as ExtensionCommandContext;
  await openMemoryPanel(ctx,service,()=>{},()=>{},()=>{if(!active)throw new Error('CANCELLED');});expect(ctx.ui.confirm).toHaveBeenCalledOnce();
  if(replaced){expect(existsSync(join(config.dataRoot,'runtime.sqlite'))).toBe(false);return;}
  const store=new RuntimeStore(config.dataRoot);try{expect(store.db.prepare('SELECT text,source,state FROM observations').get()).toEqual({text:'  Only during review: replace A with B.\n',source:'interactive',state:'pending'});}finally{store.close();}
  expect(existsSync(join(config.dataRoot,'memory/preferences.md'))).toBe(false);
});
