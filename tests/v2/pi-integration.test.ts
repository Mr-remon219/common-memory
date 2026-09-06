import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {RuntimeStore} from '../../src/v2/runtime.js';
import {PiCaptureRuntime} from '../../src/pi-extension/extraction-runtime.js';
import {branchUsers} from '../../src/pi-extension/index.js';
const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const fn of cleanup.splice(0))fn();vi.useRealTimers();});
function fixture(){const root=mkdtempSync(join(tmpdir(),'pi-v2-'));const store=new RuntimeStore(root);const run=vi.fn(async()=>({outcome:'idle'}));const close=vi.fn(()=>store.close());const runtime=new PiCaptureRuntime({store,run,close});cleanup.push(()=>{runtime.shutdown();rmSync(root,{recursive:true,force:true});});return {store,runtime,run,close};}
it('binds delivered corrections after assistant interruption, not pending inputs',()=>{
  const {store,runtime}=fixture();runtime.input({sessionId:'s',text:'Actually use B',source:'interactive',scope:'global'});
  expect(store.pending()).toHaveLength(0);runtime.delivered('s','Actually use B',1);
  expect(store.status().unbound).toBe(1);
  const entries=branchUsers([{type:'message',id:'e',message:{role:'user',content:[{type:'text',text:'Actually use B'}],timestamp:1}},{type:'message',id:'a',message:{role:'assistant',stopReason:'aborted'}}]);
  runtime.bind('s',entries);expect(store.pending()).toHaveLength(1);expect(store.pending()[0]!.text).toBe('Actually use B');
});
it('retains raw whitespace and excludes tool/system/assistant evidence',()=>{
 expect(branchUsers([{type:'message',id:'u',message:{role:'user',content:'  forget it\n',timestamp:2}},{type:'message',id:'a',message:{role:'assistant',content:'done',timestamp:3}},{type:'message',id:'t',message:{role:'toolResult',content:'done',timestamp:4}}])).toEqual([{id:'u',text:'  forget it\n',timestamp:2}]);
});
it('shutdown queues flush without waiting for maintenance or starting a model',()=>{
 const {store,runtime,run,close}=fixture();runtime.input({sessionId:'s',text:'remember',source:'rpc',scope:'global'});runtime.delivered('s','remember',4);runtime.bind('s',[{id:'e',text:'remember',timestamp:4}]);runtime.shutdown();expect(run).not.toHaveBeenCalled();expect(close).toHaveBeenCalledOnce();void store;
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
 expect(store.pending().map(o=>[o.text,o.scope])).toEqual([['B','global'],['A','global']]);
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
 runtime.delivered('s','one',1);runtime.delivered('s','two',2);runtime.bind('s',[{id:'one',text:'one',timestamp:1},{id:'two',text:'two',timestamp:2}]);expect(store.pending().map(o=>o.text)).toEqual(['one','two']);
});
it('quarantines mixed-authority queued inputs rather than trusting a stale global candidate',()=>{
 const {runtime,store}=fixture();runtime.input({sessionId:'s',text:'old',source:'interactive',scope:'global',streamingBehavior:'followUp'});runtime.input({sessionId:'s',text:'new',source:'interactive',scope:'project:p',streamingBehavior:'followUp'});
 runtime.delivered('s','old',1);runtime.bind('s',[{id:'e',text:'old',timestamp:1}]);expect(store.pending()).toHaveLength(0);
});
it('image-only delivery uses an explicit quarantine marker without image bytes',()=>{
 const entries=branchUsers([{type:'message',id:'image',message:{role:'user',timestamp:4,content:[{type:'image',data:'do-not-retain-blob'}]}}]);expect(entries).toEqual([{id:'image',timestamp:4,text:'[unsupported non-text user content]'}]);
});
