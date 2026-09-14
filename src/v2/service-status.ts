import { sanitizeDiagnostic } from '../core/contracts/diagnostic.js';
import { provenanceOf } from './import.js';
import { editResultField, jobProgress, type JobProgress, type RuntimeStore } from './runtime.js';

/** Bounded, body-free queue view. A partially visible job never exposes its ID or permits retry. */
export function scopedQueueStatus(store: RuntimeStore, scopes: readonly string[]) {
  if (!scopes.length) return {observations:[] as {state:string;count:number}[],jobStates:[] as {state:string;count:number}[],jobs:[] as QueueJob[]};
  const placeholders = scopes.map(() => '?').join(',');
  const observations = store.db.prepare(`SELECT state,COUNT(*) AS count FROM observations WHERE scope IN (${placeholders}) GROUP BY state`).all(...scopes)
    .map(r => ({state:String(r.state),count:Number(r.count)}));
  const eligible=`EXISTS(SELECT 1 FROM observations o WHERE o.jobId=j.id) AND NOT EXISTS(SELECT 1 FROM observations o WHERE o.jobId=j.id AND o.scope NOT IN (${placeholders}))`;
  const jobStates=store.db.prepare(`SELECT j.state,COUNT(*) AS count FROM jobs j WHERE ${eligible} GROUP BY j.state`).all(...scopes)
    .map(r=>({state:String(r.state),count:Number(r.count)}));
  const jobs = store.db.prepare(`SELECT j.*,EXISTS(SELECT 1 FROM receipts WHERE receipts.id=j.id) AS receiptVerified FROM jobs j WHERE ${eligible} ORDER BY CASE WHEN j.state='done' THEN 1 ELSE 0 END,j.rowid DESC LIMIT 20`).all(...scopes).map(r => {
    let diagnostic = null;
    try { diagnostic = sanitizeDiagnostic(JSON.parse(String(r.diagnostic))); } catch { /* No untrusted diagnostic text. */ }
    return {...editResultField(r.editResult),...jobProgress(r),id:String(r.id),state:String(r.state),attempts:Number(r.attempts),diagnostic,retryAt:r.state==='retry'?Number(r.available):null};
  });
  return {observations,jobStates,jobs};
}
export type QueueJob = JobProgress & {editResult?: import('./contract.js').EditResult;id:string;state:string;attempts:number;diagnostic:ReturnType<typeof sanitizeDiagnostic>;retryAt:number|null};
export function retryAuthorizedJob(store: RuntimeStore, id: string, scopes: readonly string[], provenance: readonly string[]) {
  store.transaction(() => {
    const job = store.db.prepare('SELECT state FROM jobs WHERE id=?').get(id);
    const sources = store.db.prepare('SELECT scope,source FROM observations WHERE jobId=?').all(id);
    if (!['dead','paused'].includes(String(job?.state)) || !sources.length || sources.some(r => !scopes.includes(String(r.scope)) || !provenance.includes(provenanceOf(String(r.source)) ?? ''))) throw new Error('RETRY_UNAVAILABLE');
    store.retry(id); store.requestFlush();
  });
}
