import { failureCode } from './errors.js';
import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { safeDirectory } from "./lock.js";

export interface ObservationInput { sessionId: string; entryId: string; text: string; scope: string; observedAt: string; source: string }
export interface Observation extends Omit<ObservationInput, "text"> { id: number; text: string | null; state: string; enqueuedAt: number }
export interface RuntimeJob { id: string; token: string; generation: number; observations: Observation[] }
export interface RuntimeReceipt { documents?: {target:string;after:string}[]; id?: string; token?: string; generation?: number; requestId?: string; jobId: string; observationIds: number[]; associations?: {target: string; sourceIds: number[]}[]; forgetSourceIds?: number[]; removeTargets?: string[] }
export interface RuntimeOptions { now?: () => number; turnThreshold?: number; byteThreshold?: number; idleMs?: number; maxWaitMs?: number; leaseMs?: number; maxAttempts?: number }
type Row = Record<string, string | number | null>;

/** Durable queue, not a reconstructible index. All mutating operations are synchronous. */
export class RuntimeStore {
  readonly db: DatabaseSync;
  readonly #now: () => number;
  readonly #options: Required<Omit<RuntimeOptions, "now">>;
  #depth = 0;
  constructor(dataRoot: string, options: RuntimeOptions = {}) {
    safeDirectory(dataRoot);
    const path = join(dataRoot, "runtime.sqlite");
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      try { const stat=lstatSync(path+suffix); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1) throw new Error("Unsafe runtime path"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.#now = options.now ?? Date.now;
    this.#options = {turnThreshold: options.turnThreshold ?? 6, byteThreshold: options.byteThreshold ?? 16384, idleMs: options.idleMs ?? 120000, maxWaitMs: options.maxWaitMs ?? 600000, leaseMs: options.leaseMs ?? 120000, maxAttempts: options.maxAttempts ?? 5};
    for (const value of Object.values(this.#options)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid runtime limit");
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT NOT NULL, entryId TEXT NOT NULL, text TEXT, digest TEXT NOT NULL, scope TEXT NOT NULL, observedAt TEXT NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL, enqueuedAt INTEGER NOT NULL, processedAt INTEGER, jobId TEXT, issue TEXT, UNIQUE(sessionId,entryId));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, token TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL, available INTEGER NOT NULL, issue TEXT);
      CREATE TABLE IF NOT EXISTS document_versions(target TEXT PRIMARY KEY, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS associations(target TEXT NOT NULL, sourceId INTEGER NOT NULL, PRIMARY KEY(target,sourceId));
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS inputs(id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL, scope TEXT NOT NULL, queueKind TEXT NOT NULL, parentEntryId TEXT, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS deliveries(id INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT NOT NULL, text TEXT NOT NULL, digest TEXT NOT NULL, timestamp INTEGER NOT NULL, scope TEXT NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL, UNIQUE(sessionId,digest,timestamp));
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS observations_state_id ON observations(state,id);
      CREATE INDEX IF NOT EXISTS observations_job_id ON observations(jobId,id) WHERE jobId IS NOT NULL;
      CREATE INDEX IF NOT EXISTS observations_prunable ON observations(processedAt) WHERE state='processed' AND text IS NOT NULL;
      CREATE INDEX IF NOT EXISTS jobs_active ON jobs(state) WHERE state IN ('running','retry');`);
  }
  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE"); this.#depth++;
    try { const result = fn(); if (result instanceof Promise) throw new Error("Runtime transaction must be synchronous"); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
    finally { this.#depth--; }
  }
  enqueue(input: ObservationInput): Observation {
    const digest = createHash("sha256").update(input.text).digest("hex");
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM observations WHERE sessionId=? AND entryId=?").get(input.sessionId,input.entryId) as Row | undefined;
      if (existing) { if (existing.digest !== digest || existing.scope !== input.scope || existing.source !== input.source) throw new Error("Conflicting observation identity"); return existing as unknown as Observation; }
      const state = ["interactive","rpc"].includes(input.source) ? "pending" : "quarantined";
      const result = this.db.prepare("INSERT INTO observations(sessionId,entryId,text,digest,scope,observedAt,source,state,enqueuedAt) VALUES(?,?,?,?,?,?,?,?,?)").run(input.sessionId,input.entryId,input.text,digest,input.scope,input.observedAt,input.source,state,this.#now());
      return this.db.prepare("SELECT * FROM observations WHERE id=?").get(result.lastInsertRowid) as unknown as Observation;
    });
  }
  hasWork(): boolean { return Boolean(this.db.prepare("SELECT 1 FROM observations WHERE state IN ('pending','claimed') LIMIT 1").get()); }
  pending(): Observation[] { return this.db.prepare("SELECT * FROM observations WHERE state='pending' ORDER BY id").all() as unknown as Observation[]; }
  context(observation: Observation): Observation[] {
    return (this.db.prepare("SELECT * FROM observations WHERE id<? AND sessionId=? AND scope=? AND state='processed' AND text IS NOT NULL ORDER BY id DESC LIMIT 2").all(observation.id,observation.sessionId,observation.scope) as unknown as Observation[]).reverse();
  }
  requestFlush(): void { this.db.prepare("INSERT INTO settings VALUES('flush',1) ON CONFLICT(key) DO UPDATE SET value=1").run(); }
  claim(options: {force?: boolean; maxTurns?: number} = {}): RuntimeJob | null {
    if (options.maxTurns !== undefined && (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1)) throw new Error("Invalid batch size");
    return this.transaction(() => {
      const now = this.#now();
      const active = this.db.prepare("SELECT * FROM jobs WHERE state IN ('running','retry') ORDER BY rowid LIMIT 1").get() as Row | undefined;
      if (active) {
        if (active.state === "running" && Number(active.expires) > now || Number(active.available) > now) return null;
        if (Number(active.attempts) >= this.#options.maxAttempts) { this.db.prepare("UPDATE jobs SET state='dead' WHERE id=?").run(active.id!); this.db.prepare("UPDATE observations SET state='dead' WHERE jobId=?").run(active.id!); }
        else {
          const token = randomUUID(), generation = Number(active.generation)+1;
          this.db.prepare("UPDATE jobs SET token=?,generation=?,state='running',expires=?,attempts=attempts+1 WHERE id=?").run(token,generation,now+this.#options.leaseMs,active.id!);
          return {id:String(active.id),token,generation,observations:this.db.prepare("SELECT * FROM observations WHERE jobId=? ORDER BY id").all(active.id!) as unknown as Observation[]};
        }
      }
      // Decode only a bounded queue head, not every pending conversation body.
      const head = this.db.prepare("SELECT * FROM observations WHERE state='pending' ORDER BY id LIMIT ?")
        .all(options.maxTurns ?? this.#options.turnThreshold) as unknown as Observation[];
      if (!head.length) { this.db.prepare("DELETE FROM settings WHERE key='flush'").run(); return null; }
      const flush = this.db.prepare("SELECT value FROM settings WHERE key='flush'").get();
      if (!options.force && !flush?.value) {
        // Eligibility spans all scopes, independently of this batch's capacity.
        const enoughTurns = head.length >= this.#options.turnThreshold || Boolean(this.db.prepare(
          "SELECT 1 FROM observations WHERE state='pending' ORDER BY id LIMIT 1 OFFSET ?",
        ).get(this.#options.turnThreshold - 1));
        if (!enoughTurns && now - head[0]!.enqueuedAt < this.#options.maxWaitMs) {
          // Use enqueue order, not MAX(timestamp): the host clock can move backwards.
          const latest = this.db.prepare("SELECT enqueuedAt FROM observations WHERE state='pending' ORDER BY id DESC LIMIT 1").get()!;
          if (now - Number(latest.enqueuedAt) < this.#options.idleMs) {
            // SQLite counts UTF-8 bytes including NULs without copying all bodies to JS.
            const row = this.db.prepare("SELECT SUM(length(CAST(text AS BLOB))) AS bytes FROM observations WHERE state='pending'").get()!;
            if (Number(row.bytes) < this.#options.byteThreshold) return null;
          }
        }
      }
      const observations: Observation[] = [];
      for (const observation of head) {
        if (observation.scope !== head[0]!.scope) break;
        observations.push(observation);
      }
      const id=randomUUID(),token=randomUUID();
      this.db.prepare("INSERT INTO jobs VALUES(?,?,1,'running',?,1,0,NULL)").run(id,token,now+this.#options.leaseMs);
      for (const o of observations) this.db.prepare("UPDATE observations SET state='claimed',jobId=? WHERE id=?").run(id,o.id);
      if (!this.db.prepare("SELECT 1 FROM observations WHERE state='pending' LIMIT 1").get()) this.db.prepare("DELETE FROM settings WHERE key='flush'").run();
      return {id,token,generation:1,observations};
    });
  }
  assertLease(job: RuntimeJob): void {
    const row=this.db.prepare("SELECT * FROM jobs WHERE id=? AND token=? AND generation=? AND state='running' AND expires>?").get(job.id,job.token,job.generation,this.#now());
    if (!row) throw new Error("STALE_LEASE");
  }
  trim(job: RuntimeJob, count: number): RuntimeJob {
    return this.transaction(()=>{this.assertLease(job);if(!Number.isSafeInteger(count)||count<1||count>job.observations.length)throw new Error("Invalid batch size");for(const o of job.observations.slice(count))this.db.prepare("UPDATE observations SET state='pending',jobId=NULL WHERE id=? AND jobId=?").run(o.id,job.id);return {...job,observations:job.observations.slice(0,count)};});
  }
  renew(job: RuntimeJob): void { this.transaction(()=>{this.assertLease(job);this.db.prepare("UPDATE jobs SET expires=? WHERE id=?").run(this.#now()+this.#options.leaseMs,job.id);}); }
  finish(job: RuntimeJob, receipt?: RuntimeReceipt): void { this.transaction(()=>{this.assertLease(job);if(receipt) {if(receipt.jobId!==job.id || JSON.stringify([...receipt.observationIds].sort())!==JSON.stringify(job.observations.map(o=>o.id).sort())) throw new Error("Receipt batch mismatch");this.recoverReceipt(receipt);} else this.#consume(job.id);}); }
  #consume(id: string): void {this.db.prepare("UPDATE observations SET state='processed',processedAt=? WHERE jobId=?").run(this.#now(),id);this.db.prepare("UPDATE jobs SET state='done' WHERE id=?").run(id);}
  recoverReceipt(receipt: RuntimeReceipt): void {
    this.transaction(()=>{
      if(this.db.prepare("SELECT id FROM receipts WHERE id=?").get(receipt.jobId)) return;
      const actual=this.db.prepare("SELECT id FROM observations WHERE jobId=? ORDER BY id").all(receipt.jobId).map(row=>Number(row.id));
      if(!actual.length || JSON.stringify(actual)!==JSON.stringify([...receipt.observationIds].sort((a,b)=>a-b))) throw new Error("Receipt batch mismatch");
      for(const link of receipt.associations ?? []) for(const sourceId of link.sourceIds) if(!this.db.prepare("SELECT id FROM observations WHERE id=?").get(sourceId)) throw new Error("Receipt source unknown");
      for(const id of receipt.observationIds) {const row=this.db.prepare("SELECT jobId FROM observations WHERE id=?").get(id);if(!row || row.jobId!==receipt.jobId) throw new Error("Receipt references unknown batch");}
      this.#consume(receipt.jobId);
      for (const doc of receipt.documents ?? []) this.db.prepare("INSERT INTO document_versions VALUES(?,?) ON CONFLICT(target) DO UPDATE SET hash=excluded.hash").run(doc.target,doc.after);
      for(const target of receipt.removeTargets ?? []) this.db.prepare("DELETE FROM associations WHERE target=?").run(target);
      for(const link of receipt.associations ?? []) for(const id of link.sourceIds) this.db.prepare("INSERT OR IGNORE INTO associations VALUES(?,?)").run(link.target,id);
      for(const id of receipt.forgetSourceIds ?? []) {this.db.prepare("UPDATE observations SET text=NULL WHERE id=? AND state='processed'").run(id);}
      this.db.prepare("INSERT INTO receipts VALUES(?)").run(receipt.jobId);
    });
  }
  documentVersion(target: string): string | null { const row=this.db.prepare("SELECT hash FROM document_versions WHERE target=?").get(target); return row ? String(row.hash) : null; }
  documentSourceKeys(target: string): string[] { return this.db.prepare("SELECT DISTINCT target FROM associations WHERE substr(target,1,?)=?").all(target.length+1,target+':').map(row=>String(row.target)); }
  sources(target: string): number[] {return this.db.prepare("SELECT sourceId FROM associations WHERE target=? ORDER BY sourceId").all(target).map(row=>Number(row.sourceId));}
  fail(job: RuntimeJob, error: unknown): void {this.transaction(()=>{this.assertLease(job);const row=this.db.prepare("SELECT attempts FROM jobs WHERE id=?").get(job.id)!;const dead=Number(row.attempts)>=this.#options.maxAttempts;this.db.prepare("UPDATE jobs SET state=?,available=?,issue=? WHERE id=?").run(dead?"dead":"retry",this.#now()+Math.min(600000,1000*2**(Number(row.attempts)-1)),failureCode(error),job.id);if(dead)this.db.prepare("UPDATE observations SET state='dead' WHERE jobId=?").run(job.id);});}
  quarantine(job: RuntimeJob, observationId: number, issue: string): void {this.transaction(()=>{this.assertLease(job);if(!job.observations.some(o=>o.id===observationId))throw new Error("Unknown observation");this.db.prepare("UPDATE observations SET state='quarantined',jobId=NULL,issue=? WHERE id=?").run(issue,observationId);this.db.prepare("UPDATE observations SET state='pending',jobId=NULL WHERE jobId=?").run(job.id);this.db.prepare("UPDATE jobs SET state='done' WHERE id=?").run(job.id);});}
  retry(jobId: string): void {this.transaction(()=>{this.db.prepare("UPDATE observations SET state='pending',jobId=NULL WHERE jobId=? AND state='dead'").run(jobId);this.db.prepare("UPDATE jobs SET state='done' WHERE id=? AND state='dead'").run(jobId);});}
  pruneProcessed(retentionMs=7*86400000): void {this.db.prepare("UPDATE observations INDEXED BY observations_prunable SET text=NULL WHERE state='processed' AND text IS NOT NULL AND processedAt<?").run(this.#now()-retentionMs);}
  cancelInputs(sessionId: string): void {this.db.prepare("DELETE FROM inputs WHERE sessionId=?").run(sessionId);}
  stageInput(input: {sessionId:string;text:string;source:string;scope:string;streamingBehavior?:"steer"|"followUp";parentEntryId?:string|null;hasUnsupportedContent?:boolean}): string {
    return this.transaction(()=>{
      const id=randomUUID(),kind=input.streamingBehavior??"direct";
      const prior=kind==="direct"?this.db.prepare("SELECT text FROM inputs WHERE sessionId=? AND queueKind='direct'").get(input.sessionId):undefined;
      // Direct preflight may be cancelled; queued steer/followUp are legal FIFO lists.
      if(kind==="direct")this.db.prepare("DELETE FROM inputs WHERE sessionId=? AND queueKind='direct'").run(input.sessionId);
      let source=input.hasUnsupportedContent?"unsupported_content":prior?.text===input.text?"ambiguous":input.source;
      const competing=this.db.prepare("SELECT source,scope FROM inputs WHERE sessionId=?").all(input.sessionId);
      if(competing.some(row=>row.source!==source || row.scope!==input.scope)){
        source="ambiguous";
        this.db.prepare("UPDATE inputs SET source='ambiguous' WHERE sessionId=?").run(input.sessionId);
      }
      this.db.prepare("INSERT INTO inputs(id,sessionId,text,source,scope,queueKind,parentEntryId) VALUES(?,?,?,?,?,?,?)").run(id,input.sessionId,input.text,source,input.scope,kind,input.parentEntryId??null);
      return id;
    });
  }
  delivered(sessionId:string,text:string,timestamp:number,hasUnsupportedContent=false): void {
    const digest=createHash("sha256").update(text).digest("hex");
    this.transaction(()=>{
      if(this.db.prepare("SELECT id FROM deliveries WHERE sessionId=? AND digest=? AND timestamp=?").get(sessionId,digest,timestamp))return;
      // Pi drains direct delivery, steering, then follow-up queues. Never search old
      // inputs by text: a cancelled global input must not authenticate project text.
      const expected=this.db.prepare("SELECT * FROM inputs WHERE sessionId=? ORDER BY CASE queueKind WHEN 'direct' THEN 0 WHEN 'steer' THEN 1 ELSE 2 END, rowid LIMIT 1").get(sessionId) as Row|undefined;
      const matches=expected?.text===text;
      const source=hasUnsupportedContent?"unsupported_content":matches?String(expected!.source):"ambiguous";
      this.db.prepare("INSERT OR IGNORE INTO deliveries(sessionId,text,digest,timestamp,scope,source,state) VALUES(?,?,?,?,?,?,'unbound')").run(sessionId,text,digest,timestamp,expected?.scope??"global",source);
      if(expected)this.db.prepare("DELETE FROM inputs WHERE id=?").run(expected.id!);
    });
  }
  bind(sessionId:string,entries:readonly {id:string;text:string;timestamp:number}[]): void {this.transaction(()=>{const deliveries=this.db.prepare("SELECT * FROM deliveries WHERE sessionId=? AND state='unbound' ORDER BY id").all(sessionId) as Row[];for(const delivery of deliveries){const matches=entries.filter(e=>e.text===delivery.text && e.timestamp===delivery.timestamp);if(matches.length>1){this.db.prepare("UPDATE deliveries SET state='quarantined' WHERE id=?").run(delivery.id!);continue;}if(matches.length===0)continue;this.enqueue({sessionId,entryId:matches[0]!.id,text:String(delivery.text),scope:String(delivery.scope),source:String(delivery.source),observedAt:new Date(Number(delivery.timestamp)).toISOString()});this.db.prepare("UPDATE deliveries SET state='bound',text='' WHERE id=?").run(delivery.id!);}});}
  status(): {observations:Row[];jobs:Row[];unbound:number;quarantinedDeliveries:number} {return {observations:this.db.prepare("SELECT state,COUNT(*) AS count FROM observations GROUP BY state").all() as Row[],jobs:this.db.prepare("SELECT id,state,attempts,issue FROM jobs ORDER BY rowid").all() as Row[],quarantinedDeliveries:Number(this.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE state='quarantined'").get()!.n),unbound:Number(this.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE state='unbound'").get()!.n)};}
  close(): void {this.db.close();}
}
