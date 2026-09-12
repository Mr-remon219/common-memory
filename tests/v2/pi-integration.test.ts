import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {RuntimeStore} from '../../src/v2/runtime.js';
import {PiCaptureRuntime} from '../../src/pi-extension/extraction-runtime.js';
import {branchUsers} from '../../src/pi-extension/index.js';
const cleanup:(()=>void | Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0))await fn();vi.useRealTimers();});
function fixture(){const root=mkdtempSync(join(tmpdir(),'pi-v2-'));const store=new RuntimeStore(root);const run=vi.fn(async()=>({outcome:'idle'}));const close=vi.fn(()=>store.close());const runtime=new PiCaptureRuntime({store,run,close});cleanup.push(async()=>{await runtime.shutdown();rmSync(root,{recursive:true,force:true});});return {root,store,runtime,run,close};}
it('binds delivered corrections after assistant interruption, not pending inputs',()=>{
  const {store,runtime}=fixture();runtime.input({sessionId:'s',text:'Actually use B',source:'interactive',scope:'global'});
  expect(store.pending()).toHaveLength(0);runtime.delivered('s','Actually use B',1);
  expect(store.status().unbound).toBe(1);
  const entries=branchUsers([{type:'message',id:'e',message:{role:'user',content:[{type:'text',text:'Actually use B'}],timestamp:1}},{type:'message',id:'a',message:{role:'assistant',stopReason:'aborted'}}]);
  runtime.bind('s',entries);expect(store.pending()).toHaveLength(0);expect(store.db.prepare('SELECT text FROM observations').get()!.text).toBe('Actually use B');
});
it('retains raw whitespace and excludes tool/system/assistant evidence',()=>{
 expect(branchUsers([{type:'message',id:'u',message:{role:'user',content:'  forget it\n',timestamp:2}},{type:'message',id:'a',message:{role:'assistant',content:'done',timestamp:3}},{type:'message',id:'t',message:{role:'toolResult',content:'done',timestamp:4}}])).toEqual([{id:'u',text:'  forget it\n',timestamp:2,sequence:0}]);
});
it('shutdown queues flush without starting new maintenance and awaits close',async()=>{
 const {store,runtime,run,close}=fixture();runtime.input({sessionId:'s',text:'remember',source:'rpc',scope:'global'});runtime.delivered('s','remember',4);runtime.bind('s',[{id:'e',text:'remember',timestamp:4}]);await runtime.shutdown();expect(run).not.toHaveBeenCalled();expect(close).toHaveBeenCalledOnce();void store;
});
it('starts timer checks only at stable boundaries and stops on shutdown',async()=>{
 vi.useFakeTimers();const {runtime,run}=fixture();runtime.busy();await vi.advanceTimersByTimeAsync(3000);expect(run).not.toHaveBeenCalled();runtime.settled('s',[]);await Promise.resolve();expect(run).toHaveBeenCalledOnce();runtime.shutdown();await vi.advanceTimersByTimeAsync(3000);expect(run).toHaveBeenCalledOnce();
});
it('a handled input cannot starve a stable tail maintenance timer',async()=>{
 vi.useFakeTimers();const {runtime,run}=fixture();runtime.start('s',[]);await vi.advanceTimersByTimeAsync(1);run.mockClear();
 runtime.input({sessionId:'s',text:'handled before agent_start',source:'interactive',scope:'global'});
 await vi.advanceTimersByTimeAsync(1000);expect(run).toHaveBeenCalledOnce();
});
it('stale cancelled global text cannot authenticate a transformed project delivery',()=>{
 const {runtime,store}=fixture();runtime.input({sessionId:'s',text:'X',source:'interactive',scope:'global'});
 runtime.input({sessionId:'s',text:'Y',source:'interactive',scope:'project:local',parentEntryId:'p'});
 runtime.delivered('s','X',10);runtime.bind('s',[{id:'e',text:'X',timestamp:10}]);
 expect(store.pending()).toHaveLength(0);expect(store.status().observations).toContainEqual({state:'quarantined',count:1});
 const row=store.db.prepare('SELECT scope,source FROM observations').get();expect(row).toMatchObject({scope:'project:local',source:'ambiguous'});
});
it('followUp queued before steer binds in actual steer then followUp order',()=>{
 const {runtime,store}=fixture();runtime.input({sessionId:'s',text:'A',source:'interactive',scope:'global',streamingBehavior:'followUp'});runtime.input({sessionId:'s',text:'B',source:'interactive',scope:'global',streamingBehavior:'steer'});
 runtime.delivered('s','B',10);runtime.delivered('s','A',11);runtime.bind('s',[{id:'b',text:'B',timestamp:10},{id:'a',text:'A',timestamp:11}]);
 expect(store.db.prepare("SELECT text,scope FROM observations WHERE state='buffered' ORDER BY id").all().map(o=>[o.text,o.scope])).toEqual([['B','global'],['A','global']]);
});
it('quarantines full text of nontext deliveries without retaining image blobs',()=>{
 const {runtime,store}=fixture();const content=[{type:'text',text:'See this'},{type:'image',data:'encoded-image',mimeType:'image/png'}];
 const entries=branchUsers([{type:'message',id:'e',message:{role:'user',content,timestamp:12}}]);
 expect(entries[0]!.text).toBe('See this');runtime.input({sessionId:'s',text:'See this',source:'interactive',scope:'global',hasUnsupportedContent:true});runtime.delivered('s',entries[0]!.text,12,true);runtime.bind('s',entries);
 expect(store.pending()).toHaveLength(0);expect(store.db.prepare('SELECT text,source FROM observations').get()).toMatchObject({text:'See this',source:'unsupported_content'});
});
it('superseded same-kind identical text is quarantined rather than assigned the newest scope',()=>{
 const {runtime,store}=fixture();runtime.input({sessionId:'s',text:'same',source:'interactive',scope:'global'});runtime.input({sessionId:'s',text:'same',source:'interactive',scope:'project:p'});runtime.delivered('s','same',3);runtime.bind('s',[{id:'e',text:'same',timestamp:3}]);expect(store.pending()).toHaveLength(0);
});
it.each(['steer','followUp'] as const)('preserves two legal queued %s inputs FIFO',streamingBehavior=>{
 const {runtime,store}=fixture();for(const text of ['one','two'])runtime.input({sessionId:'s',text,source:'interactive',scope:'global',streamingBehavior});
 runtime.delivered('s','one',1);runtime.delivered('s','two',2);runtime.bind('s',[{id:'one',text:'one',timestamp:1},{id:'two',text:'two',timestamp:2}]);expect(store.db.prepare("SELECT text FROM observations WHERE state='buffered' ORDER BY id").all().map(o=>o.text)).toEqual(['one','two']);
});
it('quarantines mixed-authority queued inputs rather than trusting a stale global candidate',()=>{
 const {runtime,store}=fixture();runtime.input({sessionId:'s',text:'old',source:'interactive',scope:'global',streamingBehavior:'followUp'});runtime.input({sessionId:'s',text:'new',source:'interactive',scope:'project:p',streamingBehavior:'followUp'});
 runtime.delivered('s','old',1);runtime.bind('s',[{id:'e',text:'old',timestamp:1}]);expect(store.pending()).toHaveLength(0);
});
it('image-only delivery uses an explicit quarantine marker without image bytes',()=>{
 const entries=branchUsers([{type:'message',id:'image',message:{role:'user',timestamp:4,content:[{type:'image',data:'do-not-retain-blob'}]}}]);expect(entries).toEqual([{id:'image',timestamp:4,text:'[unsupported non-text user content]',sequence:0}]);
});

// Reading: before_agent_start injects authorized canonical memory into the system prompt.
import {mkdirSync,writeFileSync} from 'node:fs';
import {createCommonMemoryPiExtension} from '../../src/pi-extension/index.js';
import {defaultConfig} from '../../src/config/config.js';
import {ProjectRegistry} from '../../src/v2/registry.js';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
function host(dataRoot:string,allowedScopes:string[]){
 const handlers=new Map<string,(event:unknown,ctx:unknown)=>unknown>();
 const commands=new Map<string,{handler:(args:string,ctx:unknown)=>Promise<void>}>();
 const pi={on:(name:string,fn:(event:unknown,ctx:unknown)=>unknown)=>{handlers.set(name,fn);},registerCommand:(name:string,command:{handler:(args:string,ctx:unknown)=>Promise<void>})=>commands.set(name,command),registerTool:()=>{}} as unknown as ExtensionAPI;
 // Read injection does not open the runtime database; keeping SQLite closed lets Windows delete the fixture.
 createCommonMemoryPiExtension({configFactory:()=>({...defaultConfig(),dataRoot,disclosure:{...defaultConfig().disclosure,allowedScopes}})})(pi);
 const ctx=(cwd:string)=>({cwd,sessionManager:{getSessionId:()=>'s',getBranch:()=>[],getLeafId:()=>null},hasPendingMessages:()=>false});
 return {before:(cwd:string)=>handlers.get('before_agent_start')!({systemPrompt:'BASE',prompt:'我是谁？'},ctx(cwd)) as {systemPrompt?:string}|undefined,handlers,refresh:(cwd:string)=>commands.get('memory-refresh')!.handler('',ctx(cwd))};
}
it('Pi freezes only its appended block and keeps the current host system prompt across turns and reload',()=>{
 const root=mkdtempSync(join(tmpdir(),'pi-read-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
 const data=join(root,'data');mkdirSync(join(root,'a'));const project=new ProjectRegistry(data).register(join(root,'a'),'A');
 mkdirSync(join(data,'memory/projects'),{recursive:true});writeFileSync(join(data,'memory/profile.md'),'# Profile\n\n## Background\nStudies ecology.\n');writeFileSync(join(data,'memory/projects',`${project.id}.md`),'# Project\n\n## Goal\nProject A goal.\n');
 const {before,handlers}=host(data,['global',`project:${project.id}`]);expect(before(join(root,'a'))!.systemPrompt).toContain('Studies ecology');
 writeFileSync(join(data,'memory/profile.md'),'# Profile\n\n## Background\nChanged\n');expect(before(join(root,'a'))!.systemPrompt).not.toContain('Changed');
 const ctx={cwd:root,sessionManager:{getSessionId:()=>'s'}};const next=handlers.get('before_agent_start')!({systemPrompt:'NEW BASE'},ctx) as {systemPrompt:string};expect(next.systemPrompt).toMatch(/^NEW BASE/);expect(next.systemPrompt).toContain('Project A goal');
 const reload=host(data,['global']);expect(reload.before(root)!.systemPrompt).toContain('Studies ecology');
});
it('unconfigured Common Memory leaves the system prompt untouched and keeps other handlers registered',()=>{
 const handlers=new Map<string,(event:unknown,ctx:unknown)=>unknown>();
 const commands=new Map<string,{handler:(args:string,ctx:unknown)=>Promise<void>}>();
 const pi={on:(name:string,fn:(event:unknown,ctx:unknown)=>unknown)=>{handlers.set(name,fn);},registerCommand:(name:string,command:{handler:(args:string,ctx:unknown)=>Promise<void>})=>commands.set(name,command),registerTool:()=>{}} as unknown as ExtensionAPI;
 createCommonMemoryPiExtension({configFactory:()=>null})(pi);
 expect(handlers.get('before_agent_start')!({systemPrompt:'BASE'},{cwd:'/'})).toBeUndefined();
 for(const name of ['session_start','input','message_end','agent_settled','session_shutdown'])expect(handlers.has(name)).toBe(true);
});

it('shutdown still aborts and closes if requesting flush fails',async()=>{
  const root=mkdtempSync(join(tmpdir(),'pi-close-failure-')),store=new RuntimeStore(root);
  const started=Promise.withResolvers<void>();let aborted=false;
  const close=vi.fn(async()=>store.close());
  const runtime=new PiCaptureRuntime({store,close,run:async options=>{started.resolve();await new Promise<void>(resolve=>options!.signal!.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));}});
  runtime.start('s',[]);await started.promise;
  vi.spyOn(store,'requestFlush').mockImplementation(()=>{throw new Error('storage failure');});
  const closing=runtime.shutdown();expect(runtime.shutdown()).toBe(closing);
  await expect(closing).rejects.toThrow('shutdown flush failed');expect(aborted).toBe(true);expect(close).toHaveBeenCalledOnce();
  rmSync(root,{recursive:true,force:true});
});
it('native memory_read remains callable with current scoped memory and shared prompt guidance',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pi-tool-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));const data=join(root,'data');
 const tools=new Map<string,Parameters<ExtensionAPI['registerTool']>[0]>();const pi={on:()=>{},registerCommand:()=>{},registerTool:(tool:Parameters<ExtensionAPI['registerTool']>[0])=>tools.set(tool.name,tool)} as unknown as ExtensionAPI;
 createCommonMemoryPiExtension({configFactory:()=>({...defaultConfig(),dataRoot:data})})(pi);
 const tool=tools.get('memory_read')!;expect(tool.promptSnippet).toBeTruthy();expect(tool.promptGuidelines?.join(' ')).toContain('什么是梯度下降');
 const ctx={cwd:root,sessionManager:{getSessionId:()=>'tool-session'}} as unknown as import('@earendil-works/pi-coding-agent').ExtensionContext;
 expect(JSON.stringify(await tool.execute('one',{},undefined,undefined,ctx))).toContain('no stored content');
 mkdirSync(join(data,'memory'),{recursive:true});writeFileSync(join(data,'memory/profile.md'),'# Profile\n\n## Background\nSynthetic fresh background\n');
 expect(JSON.stringify(await tool.execute('two',{contextId:'global'},undefined,undefined,ctx))).toContain('Synthetic fresh background');
 await expect(tool.execute('three',{contextId:'project:unauthorized'},undefined,undefined,ctx)).rejects.toThrow('CONTEXT_UNAVAILABLE');
});

it('Pi explicit refresh replaces the frozen block and subsequent canonical edits remain frozen',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pi-refresh-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'memory'),{recursive:true});const path=join(root,'memory/profile.md');
 writeFileSync(path,'# Profile\n\n## Synthetic\nSNAPSHOT_A');const h=host(root,['global']);expect(h.before(root)?.systemPrompt).toContain('SNAPSHOT_A');
 writeFileSync(path,'# Profile\n\n## Synthetic\nSNAPSHOT_B');await h.refresh(root);writeFileSync(path,'# Profile\n\n## Synthetic\nSNAPSHOT_C');expect(h.before(root)?.systemPrompt).toContain('SNAPSHOT_B');expect(h.before(root)?.systemPrompt).not.toContain('SNAPSHOT_C');
 rmSync(path);mkdirSync(path);await expect(h.refresh(root)).rejects.toThrow();expect(h.before(root)?.systemPrompt).toContain('SNAPSHOT_B');
});

// Pi 0.84.4 emits message_end before persisting the stable branch entry.
function captureHost(config:ReturnType<typeof defaultConfig>,runtimeFactory?:()=>PiCaptureRuntime){
 const handlers=new Map<string,(event:unknown,ctx:unknown)=>unknown>();const branch:unknown[]=[];
 const pi={on:(name:string,fn:(event:unknown,ctx:unknown)=>unknown)=>handlers.set(name,fn),registerCommand:()=>{},registerTool:()=>{}} as unknown as ExtensionAPI;
 createCommonMemoryPiExtension({configFactory:()=>config,...(runtimeFactory?{runtimeFactory}:{})})(pi);
 const ctx={cwd:config.dataRoot,sessionManager:{getSessionId:()=>'synthetic-event-session',getBranch:()=>branch,getLeafId:()=>null},hasPendingMessages:()=>false};
 const emit=async(name:string,event:unknown={})=>{await handlers.get(name)!(event,ctx);};
 const turn=async(n:number,source='interactive',text=`Synthetic preference ${n}`,delivered=text)=>{
  await emit('input',{source,text});await emit('agent_start');
  const message={role:'user',content:[{type:'text',text:delivered}],timestamp:n*1000};
  await emit('message_end',{message});branch.push({type:'message',id:`u${n}`,message});
  await new Promise<void>(resolve=>setImmediate(resolve));await emit('agent_settled');
 };
 return {emit,turn,branch};
}
it('actual Pi adapter order confirms ten turns and seals a quit tail without branch-only trust',async()=>{
 const {root,store,runtime}=fixture();const config={...defaultConfig(),dataRoot:root};
 const h=captureHost(config,()=>runtime);await h.emit('session_start',{reason:'startup'});
 for(let n=1;n<=10;n++)await h.turn(n);
 expect(store.db.prepare('SELECT count(*) AS n FROM observations').get()!.n).toBe(10);
 expect(store.db.prepare('SELECT count(*) AS n FROM session_batches').get()!.n).toBe(1);
 await h.turn(11);runtime.end('synthetic-event-session');
 expect(store.db.prepare('SELECT count(*) AS n FROM session_batches').get()!.n).toBe(2);
 await h.emit('session_shutdown',{reason:'reload'});
});
it('actual Pi adapter durably captures under malformed network configuration',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pi-network-'));const config=defaultConfig({COMMON_MEMORY_HOME:root});config.remote.model='fake';config.remote.proxy={mode:'env'};
 vi.stubEnv('COMMON_MEMORY_HOME',root);vi.stubEnv('OPENAI_API_KEY','synthetic');vi.stubEnv('HTTPS_PROXY','http://proxy.invalid');vi.stubEnv('https_proxy',undefined);vi.stubEnv('NO_PROXY','secret.invalid/8');vi.stubEnv('no_proxy',undefined);
 const diagnostic=vi.spyOn(process.stderr,'write').mockImplementation(()=>true);
 const h=captureHost(config);
 try {
  await h.emit('session_start',{reason:'startup'});await h.turn(1);
  const store=new RuntimeStore(config.dataRoot);
  try {expect(store.db.prepare('SELECT text,state FROM observations').all()).toEqual([{text:'Synthetic preference 1',state:'buffered'}]);}
  finally {store.close();}
  expect(diagnostic.mock.calls.flat().join('')).not.toContain('capture unavailable');
 } finally {await h.emit('session_shutdown',{reason:'reload'});diagnostic.mockRestore();vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});}
});
it.each([['extension','Synthetic injection','Synthetic injection'],['interactive','/skill:synthetic','Expanded skill instructions']])('Pi adapter never promotes %s transformed or injected input',async(source,text,delivered)=>{
 const {root,store,runtime}=fixture();const h=captureHost({...defaultConfig(),dataRoot:root},()=>runtime);await h.emit('session_start',{reason:'startup'});await h.turn(1,source,text,delivered);
 expect(store.db.prepare("SELECT count(*) AS n FROM observations WHERE state='buffered'").get()!.n).toBe(0);
});
it('capture errors report bounded actionable diagnostics, never arbitrary exception text',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pi-diagnostic-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
 const {networkConfigError}=await import('../../src/memory-manager/network/route.js');const spy=vi.spyOn(process.stderr,'write').mockImplementation(()=>true);
 try {
  const h=captureHost({...defaultConfig(),dataRoot:root},()=>{const error=networkConfigError('no_proxy_invalid');error.message='secret:do-not-print';throw error;});
  await h.emit('session_start',{reason:'startup'});for(let n=1;n<=10;n++)await h.turn(n);
  const output=spy.mock.calls.map(c=>String(c[0])).join('');expect(output).toContain('network_config/no_proxy_invalid');expect(output).toContain('config --network');expect(output).not.toContain('do-not-print');expect(spy).toHaveBeenCalledTimes(1);
 } finally {spy.mockRestore();}
});
