import { decodeText } from './sqlite.js';
import { createHash } from 'node:crypto';
import type { RuntimeStore, Observation, RuntimeJob } from './runtime.js';
import { provenanceOf } from './import.js';
import { externalPreflight } from '../core/safety/external-preflight.js';

export interface SessionIdentity { client: 'pi' | 'codex' | 'chatgpt-work'; processInstance: string; sessionId: string }
export interface SessionCacheOptions { maxSessionBytes?: number; maxTotalBytes?: number; contextTailTurns?: number }
export const SESSION_CACHE_DEFAULTS = {maxSessionBytes:8*1024*1024,maxTotalBytes:64*1024*1024,contextTailTurns:2};
export interface SessionMessage { sequence?:number; id:string; turnId:string; role:'user'|'assistant'|'tool'; text:string; scope:string; source:string; observedAt:string }
export type SessionTurnState = 'settled' | 'interrupted' | 'incomplete';
export function sessionKey(identity:SessionIdentity):string {
  if (!['pi','codex','chatgpt-work'].includes(identity.client) || !identity.processInstance || !identity.sessionId) throw new Error('INVALID_SESSION_IDENTITY');
  return 'session-'+createHash('sha256').update(JSON.stringify([identity.client,identity.processInstance,identity.sessionId])).digest('hex');
}
export function initializeSessions(store:RuntimeStore):void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, closing INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS session_turns(id INTEGER PRIMARY KEY, sessionId TEXT NOT NULL, turnId TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', batchId INTEGER, UNIQUE(sessionId,turnId));
    CREATE TABLE IF NOT EXISTS session_batches(id INTEGER PRIMARY KEY, sessionId TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session_messages(id INTEGER PRIMARY KEY, sessionId TEXT NOT NULL, messageId TEXT NOT NULL, turn INTEGER NOT NULL, role TEXT NOT NULL, digest TEXT NOT NULL, scope TEXT NOT NULL, source TEXT NOT NULL, observedAt TEXT NOT NULL, observationId INTEGER, text TEXT, unavailable TEXT, UNIQUE(sessionId,messageId));
    CREATE INDEX IF NOT EXISTS session_messages_observation ON session_messages(observationId);
    CREATE INDEX IF NOT EXISTS session_messages_turn ON session_messages(turn,id);
    CREATE INDEX IF NOT EXISTS session_turns_batch ON session_turns(batchId,id);
    CREATE TRIGGER IF NOT EXISTS session_forget_context AFTER UPDATE OF text ON observations WHEN NEW.text IS NULL BEGIN
      UPDATE session_messages SET text=NULL,unavailable='source_unavailable' WHERE role!='user' AND turn IN (SELECT turn FROM session_messages WHERE observationId=NEW.id);
    END;
  `);
  store.transaction(()=>{if(!store.db.prepare('PRAGMA table_info(session_messages)').all().some(r=>r.name==='sequence'))store.db.exec('ALTER TABLE session_messages ADD COLUMN sequence INTEGER');});
}
/** Local host ingress. User delivery authentication belongs to the versioned host adapter. */
export class SessionIngress {
  readonly limits:Required<SessionCacheOptions>;
  constructor(readonly store:RuntimeStore, options:SessionCacheOptions = {}) {
    this.limits={...SESSION_CACHE_DEFAULTS,...options};
    for(const [key,n] of Object.entries(this.limits)) if(!Number.isSafeInteger(n) || n < (key==='contextTailTurns'?0:1)) throw new Error('INVALID_SESSION_LIMIT');
  }
  open(identity:SessionIdentity):string { const key=sessionKey(identity); this.store.db.prepare('INSERT OR IGNORE INTO sessions(id) VALUES(?)').run(key); return key; }
  capture(key:string,message:SessionMessage):void {
    if(!message.id || !message.turnId || !['user','assistant','tool'].includes(message.role) || typeof message.text!=='string' || !message.text || !message.text.isWellFormed() || message.text.includes('\0') || !Number.isFinite(Date.parse(message.observedAt))) throw new Error('INVALID_SESSION_MESSAGE');
    const digest=createHash('sha256').update(JSON.stringify(message)).digest('hex');
    this.store.transaction(()=>{
      const prior=this.store.db.prepare('SELECT digest FROM session_messages WHERE sessionId=? AND messageId=?').get(key,message.id);
      if(prior) { if(prior.digest!==digest) throw new Error('SESSION_MESSAGE_CONFLICT'); return; }
      const session=this.store.db.prepare('SELECT closing FROM sessions WHERE id=?').get(key);
      if(!session || session.closing) throw new Error('SESSION_CLOSED');
      this.store.db.prepare('INSERT OR IGNORE INTO session_turns(sessionId,turnId) VALUES(?,?)').run(key,message.turnId);
      const turn=this.store.db.prepare('SELECT id,state FROM session_turns WHERE sessionId=? AND turnId=?').get(key,message.turnId)!;
      if(turn.state!=='open') throw new Error('SESSION_TURN_CLOSED');
      let observationId:number|null=null, unavailable:string|null=null;
      if(message.role==='user') {
        const o=this.store.enqueue({sessionId:key,entryId:message.id,text:message.text,scope:message.scope,source:message.source,observedAt:message.observedAt}); observationId=o.id;
        this.store.db.prepare("UPDATE observations SET state='buffered' WHERE id=? AND state='pending'").run(o.id);
      } else {
        try { externalPreflight({text:message.text},{maxExcerptBytes:this.limits.maxSessionBytes,maxCandidateBytes:this.limits.maxSessionBytes,maxTotalBytes:this.limits.maxSessionBytes}); }
        catch { unavailable='sensitive_context'; }
      }
      this.store.db.prepare('INSERT INTO session_messages(sessionId,messageId,turn,role,digest,scope,source,observedAt,observationId,text,unavailable,sequence) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(key,message.id,turn.id!,message.role,digest,message.scope,message.source,message.observedAt,observationId,message.role==='user'||unavailable?null:message.text,unavailable,message.sequence??null);
      this.reserve(key,0);
    });
  }
  reserve(key:string,bytes:number):void {
    const usage=(session:boolean)=>{
      let bytes=Number(this.store.db.prepare(`SELECT COALESCE(SUM(length(CAST(COALESCE(m.text,o.text,'') AS BLOB))),0) AS n FROM session_messages m LEFT JOIN observations o ON o.id=m.observationId ${session?'WHERE m.sessionId=?':''}`).get(...(session?[key]:[]))!.n);
      for(const [table,column] of [['inputs','text'],['deliveries','text'],['codex_inbox','body'],['codex_candidates','text'],['host_snapshots','body']] as const){
        if((table.startsWith('codex_')||table==='host_snapshots')&&!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
        bytes+=Number(this.store.db.prepare(`SELECT COALESCE(SUM(length(CAST(${column} AS BLOB))),0) AS n FROM ${table} ${session?'WHERE sessionId=?':''}`).get(...(session?[key]:[]))!.n);
      }
      return bytes;
    };
    if(usage(true)+bytes>this.limits.maxSessionBytes || usage(false)+bytes>this.limits.maxTotalBytes) throw new Error('SESSION_CAPACITY_EXCEEDED');
  }
  settle(key:string,turnId:string,state:SessionTurnState='settled'):void {
    this.store.transaction(()=>{
      const turn=this.store.db.prepare('SELECT * FROM session_turns WHERE sessionId=? AND turnId=?').get(key,turnId);
      if(!turn) return; // Undelivered inputs never count.
      if(turn.state!=='open') { if(turn.state!==state) throw new Error('SESSION_SETTLE_CONFLICT'); return; }
      const users=this.store.db.prepare("SELECT scope,source FROM session_messages WHERE turn=? AND role='user'").all(turn.id!);
      if(users.some(m=>provenanceOf(String(m.source))!=='user_explicit'||m.scope!==users[0]?.scope))this.store.db.prepare("UPDATE observations SET state='quarantined',issue='MIXED_SESSION_TURN' WHERE id IN (SELECT observationId FROM session_messages WHERE turn=?)").run(turn.id!);
      this.store.db.prepare('UPDATE session_turns SET state=? WHERE id=?').run(state,turn.id!);
      this.seal(key,false);
    });
  }
  seal(key:string,tail=false):void {
    this.store.transaction(()=>{
      const turns=this.store.db.prepare("SELECT t.id FROM session_turns t WHERE sessionId=? AND batchId IS NULL AND state!='open' AND EXISTS(SELECT 1 FROM session_messages m WHERE m.turn=t.id AND role='user') ORDER BY t.id").all(key);
      while(turns.length>=10 || tail && turns.length) {
        const group=turns.splice(0,10);
        const batch=this.store.db.prepare('INSERT INTO session_batches(sessionId) VALUES(?)').run(key).lastInsertRowid;
        for(const t of group) {
          this.store.db.prepare('UPDATE session_turns SET batchId=? WHERE id=?').run(batch,t.id!);
          this.store.db.prepare("UPDATE observations SET state='pending' WHERE state='buffered' AND id IN (SELECT observationId FROM session_messages WHERE turn=?)").run(t.id!);
        }
      }
    });
  }
  end(key:string):void {
    this.store.transaction(()=>{
      for(const turn of this.store.db.prepare("SELECT turnId FROM session_turns WHERE sessionId=? AND state='open'").all(key))this.settle(key,String(turn.turnId),'incomplete');
      this.seal(key,true);
      this.store.db.prepare('UPDATE sessions SET closing=1 WHERE id=?').run(key);
      this.store.db.prepare("UPDATE session_messages SET text=NULL,unavailable='undelivered_turn' WHERE sessionId=? AND role!='user' AND NOT EXISTS(SELECT 1 FROM session_messages u WHERE u.turn=session_messages.turn AND u.role='user')").run(key);
      this.store.cancelInputs(key);
    });
  }
  status(key:string):{closing:boolean;complete:boolean;pending:number;failed:number;batches:number} {
    const closing=Boolean(this.store.db.prepare('SELECT closing FROM sessions WHERE id=?').get(key)?.closing);
    const rows=this.store.db.prepare('SELECT state,COUNT(*) AS n FROM observations WHERE sessionId=? GROUP BY state').all(key);
    const unbound=Number(this.store.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE sessionId=? AND state='unbound'").get(key)!.n);
    const isolated=Number(this.store.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE sessionId=? AND state='quarantined'").get(key)!.n);
    const pending=unbound+rows.filter(r=>['buffered','pending','claimed'].includes(String(r.state))).reduce((n,r)=>n+Number(r.n),0);
    const failed=isolated+rows.filter(r=>['dead','quarantined'].includes(String(r.state))).reduce((n,r)=>n+Number(r.n),0);
    const incomplete=Boolean(this.store.db.prepare("SELECT 1 FROM session_turns WHERE sessionId=? AND state='incomplete' LIMIT 1").get(key));
    return {closing,complete:closing&&!pending&&!failed&&!incomplete,pending,failed,batches:Number(this.store.db.prepare('SELECT COUNT(*) AS n FROM session_batches WHERE sessionId=?').get(key)!.n)};
  }
}
export function sessionGroup(store:RuntimeStore,o:Observation):{turn:number;batch:number}|null {
  const row=store.db.prepare('SELECT m.turn,t.batchId FROM session_messages m JOIN session_turns t ON t.id=m.turn WHERE observationId=?').get(o.id);
  return row?{turn:Number(row.turn),batch:Number(row.batchId)}:null;
}
export function sessionProjection(store:RuntimeStore,job:RuntimeJob,authorized:boolean,tail=2):unknown[] {
  const first=sessionGroup(store,job.observations[0]!); if(!first)return [];
  const current=[...new Set(job.observations.map(o=>sessionGroup(store,o)!.turn))];
  const previous=store.db.prepare("SELECT t.id FROM session_turns t WHERE sessionId=? AND t.id<? AND batchId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM session_messages m LEFT JOIN observations o ON o.id=m.observationId WHERE m.turn=t.id AND (m.scope!=? OR (m.role='user' AND o.state!='processed'))) ORDER BY t.id DESC LIMIT ?").all(job.observations[0]!.sessionId,first.turn,job.observations[0]!.scope,tail).reverse().map(r=>Number(r.id));
  return [...previous,...current].map(id=>{
    const turn=store.db.prepare('SELECT turnId,state FROM session_turns WHERE id=?').get(id)!;
    return {turn_id:turn.turnId,state:turn.state,context_only:!current.includes(id),messages:store.db.prepare('SELECT m.*,CAST(m.text AS BLOB) AS text,CAST(o.text AS BLOB) AS userText FROM session_messages m LEFT JOIN observations o ON o.id=m.observationId WHERE turn=? ORDER BY COALESCE(m.sequence,m.id),m.id').all(id).map(m=>{
      decodeText(m, ['text', 'userText']);
      const canDisclose=authorized&&m.scope===job.observations[0]!.scope;
      const evidence=current.includes(id)&&m.role==='user'&&job.observations.some(o=>o.id===m.observationId);
      return {message_id:m.messageId,role:m.role,source:m.source,source_scope:m.scope,observed_at:m.observedAt,context_only:!evidence,...(evidence?{ref:`ev_${m.observationId}`}:{text:canDisclose?(m.role==='user'?m.userText:m.text):null,unavailable:!canDisclose?'unauthorized_conversation_context':m.unavailable??(m.role==='user'&&m.userText===null?'source_unavailable':null)})};
    })};
  });
}
