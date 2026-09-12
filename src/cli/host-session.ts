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
    CREATE TABLE IF NOT EXISTS host_snapshots(sessionId TEXT PRIMARY KEY,body TEXT NOT NULL,pending INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS codex_cursors(sessionId TEXT PRIMARY KEY,path TEXT NOT NULL,offset INTEGER NOT NULL,turnId TEXT);
    CREATE TABLE IF NOT EXISTS codex_inbox(id INTEGER PRIMARY KEY,sessionId TEXT NOT NULL,event TEXT NOT NULL,turnId TEXT,start INTEGER NOT NULL,body TEXT NOT NULL,scope TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS codex_candidates(sessionId TEXT NOT NULL,turnId TEXT NOT NULL,digest TEXT NOT NULL,text TEXT,PRIMARY KEY(sessionId,turnId,digest));
    CREATE TABLE IF NOT EXISTS codex_watches(sessionId TEXT NOT NULL,turnId TEXT NOT NULL,PRIMARY KEY(sessionId,turnId));`);
  store.transaction(()=>{if(!store.db.prepare('PRAGMA table_info(codex_candidates)').all().some(r=>r.name==='scope'))store.db.exec('ALTER TABLE codex_candidates ADD COLUMN scope TEXT');});
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
  try {setupHostAdapter(store);return store.transaction(()=>{
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
  });}finally{store.close();}
}
function fstatSize(path:string):number {const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{return fstatSync(fd).size;}finally{closeSync(fd);}}
export async function consumeCodexInbox(config:CommonMemoryConfig, progressCallback?:()=>Promise<void>):Promise<void> {
  const store=new RuntimeStore(config.dataRoot);
  try {
    setupHostAdapter(store);
    const ingress=new SessionIngress(store,config.sessionCache);
    const deadline=Date.now()+60000;
    for(;;) {
      if(Date.now()>deadline)throw new Error('CODEX_COMPLETION_UNCONFIRMED');
      const consumed=store.transaction(()=>{
        const row=decodeText(store.db.prepare('SELECT *, CAST(body AS BLOB) AS body FROM codex_inbox ORDER BY id LIMIT 1').get(), ['body']);if(!row)return false;
        const key=String(row.sessionId),cursor=store.db.prepare('SELECT * FROM codex_cursors WHERE sessionId=?').get(key)!;
        if(row.start!==cursor.offset)throw new Error('CODEX_CURSOR_CONFLICT');
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
        return true;
      });
      if(consumed){await progressCallback?.();continue;}
      const watches=store.db.prepare('SELECT w.*,c.path,c.offset,c.turnId AS activeTurn FROM codex_watches w JOIN codex_cursors c ON c.sessionId=w.sessionId').all();
      if(!watches.length)return;
      let progress=false;
      for(const w of watches)store.transaction(()=>{
        const state=store.db.prepare('SELECT state FROM session_turns WHERE sessionId=? AND turnId=?').get(w.sessionId!,w.turnId!);
        if(state&&state.state!=='open') {store.db.prepare('DELETE FROM codex_watches WHERE sessionId=? AND turnId=?').run(w.sessionId!,w.turnId!);progress=true;return;}
        if(store.db.prepare('SELECT 1 FROM codex_inbox WHERE sessionId=?').get(w.sessionId!))return;
        const cursor=store.db.prepare('SELECT * FROM codex_cursors WHERE sessionId=?').get(w.sessionId!)!;
        const snapshot=transcript(String(cursor.path),Number(cursor.offset),ingress.limits.maxSessionBytes);
        if(!snapshot.text)return;
        const scope=String(store.db.prepare('SELECT scope FROM session_messages WHERE sessionId=? ORDER BY id DESC LIMIT 1').get(w.sessionId!)?.scope??'global');
        ingress.reserve(String(w.sessionId),Buffer.byteLength(snapshot.text));
        store.db.prepare("INSERT INTO codex_inbox(sessionId,event,start,body,scope) VALUES(?,'Reconcile',?,?,?)").run(w.sessionId!,cursor.offset!,snapshot.text,scope);progress=true;
      });
      if(!progress){await progressCallback?.();await setTimeout(100);}
    }
  }finally{store.close();}
}

export type HostClient = 'codex' | 'chatgpt-work';
