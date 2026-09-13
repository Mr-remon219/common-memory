import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { tempRoots } from '../helpers/temp-roots.js';
import { defaultConfig } from '../../src/config/config.js';
import { RuntimeStore } from '../../src/v2/runtime.js';
import { SessionIngress } from '../../src/v2/session.js';
import { consumeCodexInbox, hostQueueStatus, recoverCodexInbox, setupHostAdapter } from '../../src/cli/host-session.js';
const roots=tempRoots('cm-host-boundaries-');
afterEach(()=>{vi.restoreAllMocks();roots.cleanup();});
function fixture(){
  const config=defaultConfig({COMMON_MEMORY_HOME:roots.root()});
  const store=new RuntimeStore(config.dataRoot);setupHostAdapter(store);
  const key=new SessionIngress(store).open({client:'codex',processInstance:'synthetic',sessionId:'s'});
  store.db.prepare('INSERT INTO codex_cursors(sessionId,path,offset) VALUES(?,?,0)').run(key,'/unused');
  return {config,store,key};
}
it('bounds the whole drain even with continuous progress, retaining the next inbox row',async()=>{
  const {config,store,key}=fixture();
  try{for(let i=0;i<2;i++)store.db.prepare("INSERT INTO codex_inbox(sessionId,event,start,body,scope) VALUES(?,'SessionStart',0,'','global')").run(key);}finally{store.close();}
  let now=1000000,calls=0;vi.spyOn(Date,'now').mockImplementation(()=>now);
  const status=await consumeCodexInbox(config,async()=>{calls++;now+=61000;});
  expect(calls).toBe(1);expect(status).toMatchObject({complete:false,inbox:1,isolated:0});
  expect(await consumeCodexInbox(config)).toMatchObject({complete:true,inbox:0});
});
it.each([false,true])('does not quarantine concurrent successful consumption, including rowid reuse=%s',async reuse=>{
  const {config,store,key}=fixture(),text='Synthetic authenticated expression';
  const event=(payload:object)=>JSON.stringify({timestamp:'2026-09-09T00:00:00.000Z',type:'event_msg',payload})+'\n';
  const body=JSON.stringify({type:'session_meta',payload:{cli_version:'0.153.4',id:'s'}})+'\n'+event({type:'task_started',turn_id:'t'})+event({type:'user_message',message:text})+event({type:'task_complete',turn_id:'t'});
  try{store.db.prepare("INSERT INTO codex_inbox(sessionId,event,start,body,scope) VALUES(?,'SessionEnd',0,?,'global')").run(key,body);}finally{store.close();}
  const original=RuntimeStore.prototype.transaction;let armed=true,concurrent:ReturnType<typeof consumeCodexInbox>|undefined;
  vi.spyOn(RuntimeStore.prototype,'transaction').mockImplementation(function<T>(this:RuntimeStore,fn:()=>T):T{
    try{return original.call(this,fn) as T;}catch(error){
      if(armed&&error instanceof Error&&error.message==='CODEX_UNCONFIRMED_DELIVERY'){
        armed=false;
        const other=new RuntimeStore(config.dataRoot);
        try{
          // Interleave a genuine candidate arrival and another consumer's commit
          // after the first rollback, before it records its old failure.
          other.db.prepare('INSERT INTO codex_candidates(sessionId,turnId,digest,text,scope) VALUES(?,?,?,?,?)').run(key,'t',createHash('sha256').update(text).digest('hex'),text,'global');
          concurrent=consumeCodexInbox(config);
          expect(other.db.prepare('SELECT COUNT(*) AS n FROM codex_inbox').get()!.n).toBe(0);
          if(reuse)other.db.prepare("INSERT INTO codex_inbox(id,sessionId,event,start,body,scope) VALUES(1,?,'SessionStart',?,'','global')").run(key,Buffer.byteLength(body));
        }finally{other.close();}
      }
      throw error;
    }
  });
  const status=await consumeCodexInbox(config);await concurrent;
  expect(armed).toBe(false);expect(status).toMatchObject({complete:true,inbox:0,isolated:0});
  const final=new RuntimeStore(config.dataRoot);
  try{expect(final.db.prepare('SELECT COUNT(*) AS n FROM observations').get()!.n).toBe(1);expect(final.db.prepare('SELECT COUNT(*) AS n FROM codex_failures').get()!.n).toBe(0);}finally{final.close();}
});
it('pages every recovery ID while preserving total counts and a bounded body-free page',()=>{
  const {config,store,key}=fixture();
  try{
    for(let i=1;i<=21;i++)store.db.prepare('INSERT INTO codex_failures(sessionId,recoveryId,issue,failedAt) VALUES(?,?,?,?)').run(`${key}-${i}`,`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,'CODEX_UNKNOWN_TRANSCRIPT',i);
    const first=hostQueueStatus(store);expect(first.isolated).toBe(21);expect(first.recoveries).toHaveLength(20);expect(first.nextRecoveryId).not.toBeNull();
    const last=hostQueueStatus(store,first.nextRecoveryId!);expect(last.isolated).toBe(21);expect(last.recoveries).toHaveLength(1);expect(last.nextRecoveryId).toBeNull();
    expect(new Set([...first.recoveries,...last.recoveries].map(r=>r.id)).size).toBe(21);
    recoverCodexInbox(config,last.recoveries[0]!.id);
    expect(hostQueueStatus(store,first.nextRecoveryId!).recoveries[0]!.retryRequested).toBe(true);
    expect(JSON.stringify(last)).not.toContain('body');
  }finally{store.close();}
});
