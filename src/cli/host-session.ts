import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync, fstatSync } from 'node:fs';
import { hostProcessInstance } from './host-process.js';
import { constants } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import type { CommonMemoryConfig } from '../config/config.js';
import { decodeText } from '../v2/sqlite.js';
import { RuntimeStore } from '../v2/runtime.js';
import { SessionIngress, sessionKey, type SessionIdentity } from '../v2/session.js';
import { ProjectRegistry } from '../v2/registry.js';
import { admitSessionMeta } from './codex/rollout-contract.js';
import { parseTranscript } from './codex/transcript-codex-host.js';
export interface CodexEvent { hook_event_name:'SessionStart'|'UserPromptSubmit'|'Stop'|'SessionEnd'|'Interrupt'|'PostToolUse';cwd:string;session_id:string;transcript_path:string;source?:string;turn_id?:string;prompt?:string }
export function setupHostAdapter(store:RuntimeStore):void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS host_activations(base TEXT PRIMARY KEY,sessionId TEXT NOT NULL,client TEXT NOT NULL,instance TEXT NOT NULL,thread TEXT NOT NULL,cwd TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS host_snapshots(sessionId TEXT PRIMARY KEY,body TEXT NOT NULL,pending INTEGER NOT NULL DEFAULT 0,authorization TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE IF NOT EXISTS codex_cursors(sessionId TEXT PRIMARY KEY,path TEXT NOT NULL,offset INTEGER NOT NULL,turnId TEXT);
    CREATE TABLE IF NOT EXISTS codex_inbox(id INTEGER PRIMARY KEY,sessionId TEXT NOT NULL,event TEXT NOT NULL,turnId TEXT,start INTEGER NOT NULL,body TEXT NOT NULL,scope TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS codex_candidates(sessionId TEXT NOT NULL,turnId TEXT NOT NULL,digest TEXT NOT NULL,text TEXT,PRIMARY KEY(sessionId,turnId,digest));
    CREATE TABLE IF NOT EXISTS codex_watches(sessionId TEXT NOT NULL,turnId TEXT NOT NULL,PRIMARY KEY(sessionId,turnId));
    CREATE TABLE IF NOT EXISTS codex_failures(sessionId TEXT PRIMARY KEY,inboxId INTEGER,recoveryId TEXT NOT NULL UNIQUE,issue TEXT NOT NULL,failedAt INTEGER NOT NULL,retryRequested INTEGER NOT NULL DEFAULT 0);`);
  store.transaction(()=>{if(!store.db.prepare('PRAGMA table_info(codex_candidates)').all().some(r=>r.name==='scope'))store.db.exec('ALTER TABLE codex_candidates ADD COLUMN scope TEXT');if(!store.db.prepare('PRAGMA table_info(host_snapshots)').all().some(r=>r.name==='authorization'))store.db.exec("ALTER TABLE host_snapshots ADD COLUMN authorization TEXT NOT NULL DEFAULT '[]'");});
}

const HOST_SESSION_FAILURES = new Set([
  'CODEX_UNKNOWN_TRANSCRIPT','CODEX_UNKNOWN_COMPLETION','CODEX_UNSUPPORTED_VERSION','CODEX_CURSOR_CONFLICT','CODEX_UNCONFIRMED_DELIVERY','CODEX_UNSETTLED_TURN',
  'CODEX_UNSAFE_TRANSCRIPT','CODEX_TRANSCRIPT_REPLACED',
  'INVALID_SESSION_MESSAGE','SESSION_MESSAGE_CONFLICT','SESSION_CLOSED','SESSION_TURN_CLOSED','SESSION_SETTLE_CONFLICT',
]);
export interface HostRecoveryStatus { id:string; issue:string; event:string; failedAt:number; retryRequested:boolean }
export interface HostQueueStatus {
  complete:boolean; inbox:number; isolated:number; watches:number;
  recoveries:HostRecoveryStatus[]; nextRecoveryId:string|null;
  sessions:{sessionId:string;inbox:number;isolated:number;watches:number}[];
}
function hostFailureCode(error:unknown):string|null {
  const code=error instanceof Error?error.message:'';
  return HOST_SESSION_FAILURES.has(code)?code:null;
}
function recordHostFailure(store:RuntimeStore,sessionId:string,inboxId:number|null,error:unknown,identity:{start:number}|{turnId:string;offset:number}):boolean {
  const issue=hostFailureCode(error);if(!issue)return false;
  store.transaction(()=>{
    // The failed transaction has rolled back. Another consumer may already have
    // resolved this exact work; rowid alone can also have been reused meanwhile.
    const pending='start' in identity
      ? store.db.prepare('SELECT 1 FROM codex_inbox WHERE id=? AND sessionId=? AND start=?').get(inboxId,sessionId,identity.start)
      : store.db.prepare('SELECT 1 FROM codex_watches w JOIN codex_cursors c ON c.sessionId=w.sessionId WHERE w.sessionId=? AND w.turnId=? AND c.offset=?').get(sessionId,identity.turnId,identity.offset);
    if(!pending)return;
    store.db.prepare(`INSERT INTO codex_failures(sessionId,inboxId,recoveryId,issue,failedAt,retryRequested) VALUES(?,?,?,?,?,0)
      ON CONFLICT(sessionId) DO UPDATE SET inboxId=excluded.inboxId,issue=excluded.issue,failedAt=excluded.failedAt,retryRequested=0`)
      .run(sessionId,inboxId,randomUUID(),issue,Date.now());
  });
  return true;
}
function hasHostTable(store:RuntimeStore,name:string):boolean {
  return Boolean(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
/** Body-free status for host admission. Failure reasons are fixed local enums, never exception text. */
export function hostQueueStatus(store:RuntimeStore,afterRecoveryId=''):HostQueueStatus {
  if(afterRecoveryId&&!/^[0-9a-f-]{36}$/iu.test(afterRecoveryId))throw new Error('CODEX_RECOVERY_UNAVAILABLE');
  if(!hasHostTable(store,'codex_inbox'))return {complete:true,inbox:0,isolated:0,watches:0,recoveries:[],nextRecoveryId:null,sessions:[]};
  const hasFailures=hasHostTable(store,'codex_failures'),hasWatches=hasHostTable(store,'codex_watches');
  const inboxRows=store.db.prepare('SELECT sessionId,COUNT(*) AS n FROM codex_inbox GROUP BY sessionId').all();
  const failureRows=hasFailures?store.db.prepare('SELECT sessionId FROM codex_failures').all():[];
  const watchRows=hasWatches?store.db.prepare('SELECT sessionId,COUNT(*) AS n FROM codex_watches GROUP BY sessionId').all():[];
  const inbox=inboxRows.reduce((n,r)=>n+Number(r.n),0),isolated=failureRows.length,watches=watchRows.reduce((n,r)=>n+Number(r.n),0);
  const recoveries=hasFailures?store.db.prepare(`SELECT f.recoveryId,f.issue,f.failedAt,f.retryRequested,COALESCE(i.event,'Reconcile') AS event FROM codex_failures f
    LEFT JOIN codex_inbox i ON i.id=f.inboxId AND i.sessionId=f.sessionId WHERE f.recoveryId>? ORDER BY f.recoveryId LIMIT 21`).all(afterRecoveryId)
    .map(r=>({id:String(r.recoveryId),issue:String(r.issue),event:String(r.event),failedAt:Number(r.failedAt),retryRequested:Boolean(r.retryRequested)})):[];
  const bySession=new Map<string,{sessionId:string;inbox:number;isolated:number;watches:number}>();
  const session=(id:unknown)=>{const key=String(id),prior=bySession.get(key);if(prior)return prior;const created={sessionId:key,inbox:0,isolated:0,watches:0};bySession.set(key,created);return created;};
  for(const row of inboxRows)session(row.sessionId).inbox=Number(row.n);
  for(const row of failureRows)session(row.sessionId).isolated=1;
  for(const row of watchRows)session(row.sessionId).watches=Number(row.n);
  const sessions=[...bySession.values()].sort((a,b)=>a.sessionId.localeCompare(b.sessionId));
  return {complete:inbox===0&&isolated===0&&watches===0,inbox,isolated,watches,recoveries:recoveries.slice(0,20),nextRecoveryId:recoveries.length>20?recoveries[19]!.id:null,sessions};
}
/** Explicitly retries the same retained inbox/watch identity. It never edits or discards host material. */
export function recoverCodexInbox(config:CommonMemoryConfig,recoveryId:string):void {
  const store=new RuntimeStore(config.dataRoot);
  try {recoverCodexInboxInStore(store,recoveryId);}finally{store.close();}
}
export function recoverCodexInboxInStore(store:RuntimeStore,recoveryId:string):void {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(recoveryId))throw new Error('CODEX_RECOVERY_UNAVAILABLE');
  setupHostAdapter(store);const result=store.db.prepare('UPDATE codex_failures SET retryRequested=1 WHERE recoveryId=?').run(recoveryId);if(result.changes!==1)throw new Error('CODEX_RECOVERY_UNAVAILABLE');
}
export const codexProcessInstance = hostProcessInstance;
function transcript(path:string,offset:number|null,cap:number):{text:string;end:number} {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1)throw new Error('CODEX_UNSAFE_TRANSCRIPT');
    const header=Buffer.alloc(Math.min(stat.size,65536));readSync(fd,header,0,header.length,0);
    let meta: {type?:string;payload?:{cli_version?:string}};
    try {meta=JSON.parse(header.subarray(0,header.indexOf(10)).toString('utf8'));}catch{throw new Error('CODEX_UNKNOWN_TRANSCRIPT');}
    admitSessionMeta(meta);
    if(offset===null)return {text:'',end:stat.size};
    if(stat.size<offset)throw new Error('CODEX_TRANSCRIPT_REPLACED');
    if(stat.size-offset>cap)throw new Error('SESSION_CAPACITY_EXCEEDED');
    const buffer=Buffer.alloc(stat.size-offset);let read=0;
    while(read<buffer.length) {const n=readSync(fd,buffer,read,buffer.length-read,offset+read);if(!n)throw new Error('CODEX_TRANSCRIPT_CHANGED');read+=n;}
    // Never advance over a partial JSONL record. SessionEnd reports it as a failure.
    const complete=buffer.lastIndexOf(10)+1;
    return {text:new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,complete)),end:offset+complete};
  }finally{closeSync(fd);}
}
/** SQLite WAL + synchronous=FULL is the atomic, fsynced inbox. No remote work in a hook. */
export function enqueueCodexEvent(config:CommonMemoryConfig,event:CodexEvent,instance=codexProcessInstance(),client:HostClient='codex'):{key:string;initial:boolean} {
  const store=new RuntimeStore(config.dataRoot,{sqliteTimeoutMs:150});
  try {return enqueueCodexEventInStore(store,config,event,instance,client);}finally{store.close();}
}
/** Service-side ingress. The request journal and complete host inbox admission share one transaction. */
export function enqueueCodexEventInStore(store:RuntimeStore,config:CommonMemoryConfig,event:CodexEvent,instance=codexProcessInstance(),client:HostClient='codex'):{key:string;initial:boolean} {
  setupHostAdapter(store);return store.transaction(()=>{
    const ingress=new SessionIngress(store,config.sessionCache);
    let identity:SessionIdentity={client,processInstance:instance,sessionId:event.session_id};
    const base=sessionKey(identity),activation=store.db.prepare('SELECT * FROM host_activations WHERE base=?').get(base);
    if(activation && !activation.active && (event.hook_event_name!=='SessionStart'||!['startup','resume'].includes(event.source??'')))throw new Error('CODEX_SESSION_START_REQUIRED');
    if(activation && !activation.active)identity={...identity,processInstance:instance+':'+randomUUID()};
    const key=activation?.active?String(activation.sessionId):sessionKey(identity);
    if(!activation?.active)store.db.prepare('INSERT OR REPLACE INTO host_activations VALUES(?,?,?,?,?,?,1)').run(base,key,client,instance,event.session_id,event.cwd);
    else store.db.prepare('UPDATE host_activations SET cwd=? WHERE base=?').run(event.cwd,base);
    const prior=store.db.prepare('SELECT * FROM codex_cursors WHERE sessionId=?').get(key);
    const initial=!prior;
    if(!prior) {
      if(event.hook_event_name!=='SessionStart')throw new Error('CODEX_SESSION_START_REQUIRED');
      const start=transcript(event.transcript_path,null,ingress.limits.maxSessionBytes);
      ingress.open(identity);
      store.db.prepare('INSERT INTO codex_cursors(sessionId,path,offset) VALUES(?,?,?)').run(key,event.transcript_path,start.end);
    } else if(prior.path!==event.transcript_path)throw new Error('CODEX_TRANSCRIPT_REPLACED');
    const project=new ProjectRegistry(config.dataRoot).resolve(event.cwd),scope=project?`project:${project.id}`:'global';
    if(event.hook_event_name==='UserPromptSubmit'){
      if(typeof event.prompt!=='string'||!event.turn_id)throw new Error('CODEX_INPUT_IDENTITY_REQUIRED');
      store.db.prepare('INSERT OR IGNORE INTO codex_candidates(sessionId,turnId,digest,text,scope) VALUES(?,?,?,?,?)').run(key,event.turn_id,createHash('sha256').update(event.prompt).digest('hex'),event.prompt,scope);
    }
    const cursor=store.db.prepare('SELECT offset FROM codex_cursors WHERE sessionId=?').get(key)!;
    const queued=store.db.prepare('SELECT start,length(CAST(body AS BLOB)) AS bytes FROM codex_inbox WHERE sessionId=? ORDER BY id DESC LIMIT 1').get(key);
    const offset=queued?Number(queued.start)+Number(queued.bytes):Number(cursor.offset);
    const snapshot=transcript(event.transcript_path,offset,ingress.limits.maxSessionBytes);
    if(event.hook_event_name==='SessionEnd'&&fstatSize(event.transcript_path)!==snapshot.end)throw new Error('CODEX_PARTIAL_TRANSCRIPT');
    const bytes=Buffer.byteLength(snapshot.text);
    ingress.reserve(key,bytes);

    store.db.prepare('INSERT INTO codex_inbox(sessionId,event,turnId,start,body,scope) VALUES(?,?,?,?,?,?)').run(key,event.hook_event_name,event.turn_id??null,offset,snapshot.text,scope);
    if(event.hook_event_name==='SessionEnd'){store.db.prepare('UPDATE host_activations SET active=0 WHERE base=?').run(base);store.db.prepare('DELETE FROM host_snapshots WHERE sessionId=?').run(key);}
    return {key,initial};
  });
}
function fstatSize(path:string):number {const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{return fstatSync(fd).size;}finally{closeSync(fd);}}
export async function consumeCodexInbox(config:CommonMemoryConfig, progressCallback?:()=>Promise<void>, options:{singlePass?:boolean;store?:RuntimeStore}={}):Promise<HostQueueStatus> {
  const store=options.store??new RuntimeStore(config.dataRoot);
  try {
    setupHostAdapter(store);
    const ingress=new SessionIngress(store,config.sessionCache);
    const deadline=Date.now()+60000;
    for(;;) {
      if(Date.now()>=deadline)return hostQueueStatus(store);
      const next=store.db.prepare(`SELECT i.id,i.sessionId,i.start FROM codex_inbox i LEFT JOIN codex_failures f ON f.sessionId=i.sessionId
        WHERE f.sessionId IS NULL OR f.retryRequested=1 ORDER BY i.id LIMIT 1`).get();
      if(next){
        let consumed=false;
        try {consumed=store.transaction(()=>{
          const row=decodeText(store.db.prepare(`SELECT i.*,CAST(i.body AS BLOB) AS body FROM codex_inbox i LEFT JOIN codex_failures f ON f.sessionId=i.sessionId
            WHERE i.id=? AND i.sessionId=? AND i.start=? AND (f.sessionId IS NULL OR f.retryRequested=1)`).get(next.id!,next.sessionId!,next.start!), ['body']);if(!row)return false;
          const key=String(row.sessionId),cursor=store.db.prepare('SELECT * FROM codex_cursors WHERE sessionId=?').get(key);
          if(!cursor||row.start!==cursor.offset)throw new Error('CODEX_CURSOR_CONFLICT');
          const parsed=parseTranscript(String(row.body),{offset:Number(cursor.offset),turnId:cursor.turnId===null?null:String(cursor.turnId)},String(row.scope));
          // Replacing the inbox body by session rows is one transaction, without duplicate durable bodies.
          store.db.prepare('DELETE FROM codex_inbox WHERE id=?').run(row.id!);
          for(const action of parsed.actions) {if(action.kind==='message'){
            if(action.message.role==='user'){
              const digest=createHash('sha256').update(action.message.text).digest('hex');
              const candidate=store.db.prepare('SELECT digest,scope,text FROM codex_candidates WHERE sessionId=? AND turnId=? AND digest=?').get(key,action.message.turnId,digest);
              if(!candidate||typeof candidate.scope!=='string')throw new Error('CODEX_UNCONFIRMED_DELIVERY');
              if(candidate.text===null)continue;
              action.message.scope=candidate.scope;
              store.db.prepare('UPDATE codex_candidates SET text=NULL WHERE sessionId=? AND turnId=? AND digest=?').run(key,action.message.turnId,digest);
            }
            ingress.capture(key,action.message);
          }else ingress.settle(key,action.turnId,action.state);}
          store.db.prepare('UPDATE codex_cursors SET offset=?,turnId=? WHERE sessionId=?').run(parsed.state.offset,parsed.state.turnId,key);
          if((row.event==='Stop'||row.event==='Interrupt')&&row.turnId)store.db.prepare('INSERT OR IGNORE INTO codex_watches VALUES(?,?)').run(key,row.turnId);
          if(row.event==='SessionEnd') {ingress.end(key);store.db.prepare('UPDATE codex_candidates SET text=NULL WHERE sessionId=?').run(key);store.db.prepare('DELETE FROM codex_watches WHERE sessionId=?').run(key);}
          store.db.prepare('DELETE FROM codex_failures WHERE sessionId=?').run(key);
          return true;
        });}catch(error){if(!recordHostFailure(store,String(next.sessionId),Number(next.id),error,{start:Number(next.start)}))throw error;}
        if(consumed)await progressCallback?.();
        if(options.singlePass)return hostQueueStatus(store);
        continue;
      }
      const watches=store.db.prepare(`SELECT w.*,c.path,c.offset,c.turnId AS activeTurn FROM codex_watches w JOIN codex_cursors c ON c.sessionId=w.sessionId
        LEFT JOIN codex_failures f ON f.sessionId=w.sessionId WHERE f.sessionId IS NULL OR f.retryRequested=1`).all();
      if(!watches.length)return hostQueueStatus(store);
      let progress=false;
      for(const w of watches){
        if(Date.now()>=deadline)return hostQueueStatus(store);
        try {store.transaction(()=>{
          if(!store.db.prepare('SELECT 1 FROM codex_watches WHERE sessionId=? AND turnId=?').get(w.sessionId!,w.turnId!))return;
          const failure=store.db.prepare('SELECT retryRequested FROM codex_failures WHERE sessionId=?').get(w.sessionId!);if(failure&&!failure.retryRequested)return;
          const state=store.db.prepare('SELECT state FROM session_turns WHERE sessionId=? AND turnId=?').get(w.sessionId!,w.turnId!);
          if(state&&state.state!=='open') {store.db.prepare('DELETE FROM codex_watches WHERE sessionId=? AND turnId=?').run(w.sessionId!,w.turnId!);store.db.prepare('DELETE FROM codex_failures WHERE sessionId=?').run(w.sessionId!);progress=true;return;}
          if(store.db.prepare('SELECT 1 FROM codex_inbox WHERE sessionId=?').get(w.sessionId!))return;
          const cursor=store.db.prepare('SELECT * FROM codex_cursors WHERE sessionId=?').get(w.sessionId!);
          if(!cursor)throw new Error('CODEX_CURSOR_CONFLICT');
          const snapshot=transcript(String(cursor.path),Number(cursor.offset),ingress.limits.maxSessionBytes);
          if(!snapshot.text)return;
          const scope=String(store.db.prepare('SELECT scope FROM session_messages WHERE sessionId=? ORDER BY id DESC LIMIT 1').get(w.sessionId!)?.scope??'global');
          ingress.reserve(String(w.sessionId),Buffer.byteLength(snapshot.text));
          store.db.prepare("INSERT INTO codex_inbox(sessionId,event,start,body,scope) VALUES(?,'Reconcile',?,?,?)").run(w.sessionId!,cursor.offset!,snapshot.text,scope);progress=true;
        });}catch(error){if(!recordHostFailure(store,String(w.sessionId),null,error,{turnId:String(w.turnId),offset:Number(w.offset)}))throw error;progress=true;}
      }
      if(options.singlePass)return hostQueueStatus(store);
      if(!progress){
        await progressCallback?.();
        if(Date.now()>deadline)return hostQueueStatus(store);
        await setTimeout(100);
      }
    }
  }finally{if(!options.store)store.close();}
}

export type HostClient = 'codex' | 'chatgpt-work';
