import { randomUUID } from "node:crypto";
import { sourceDigest } from "../../core/governance/governance-digest.js";
import { mkdirSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeObservationReference, type ObservationReference } from "../contracts/observation.js";
import type { MemoryRunOutcome } from "../contracts/run.js";
export interface SchedulerJob { jobId: string; repositoryId: string; scope: string; trigger: string; sourceDigest: string; checkpoint: string | null; observations: ObservationReference[]; attempt: number; availableAt: number; leaseUntil: number | null; leaseToken: string | null; leaseGeneration: number }
export interface SchedulerEnqueueInput { jobId: string; repositoryId: string; scope: string; trigger: string; checkpoint: string | null; observations: ObservationReference[]; availableAt: number }
export class MemoryManagerJobStore implements Disposable {
  readonly #db: DatabaseSync;
  constructor(stateRoot: string) {
    const root = resolve(stateRoot); mkdirSync(root, { recursive: true, mode: 0o700 }); if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) throw new Error("stateRoot must be a real local directory");
    this.#db = new DatabaseSync(join(root, "memory-manager.sqlite")); this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    this.#db.exec(`CREATE TABLE IF NOT EXISTS jobs(job_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, scope TEXT NOT NULL, trigger TEXT NOT NULL, source_digest TEXT NOT NULL, checkpoint TEXT, observation_refs TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','leased')), attempt INTEGER NOT NULL, available_at INTEGER NOT NULL, lease_until INTEGER, lease_token TEXT, lease_generation INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(repository_id,scope,source_digest)); CREATE INDEX IF NOT EXISTS jobs_claim ON jobs(status,available_at,lease_until); CREATE TABLE IF NOT EXISTS runs(run_id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, outcome TEXT NOT NULL, reason_code TEXT, batch_id TEXT, usage_input INTEGER, usage_output INTEGER, usage_total INTEGER, refusal_fingerprint TEXT, finished_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS completed_sources(repository_id TEXT NOT NULL,scope TEXT NOT NULL,source_digest TEXT NOT NULL,finished_at INTEGER NOT NULL,PRIMARY KEY(repository_id,scope,source_digest));`);
    const columns = new Set((this.#db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>).map((column) => column.name)); if (!columns.has("lease_token")) this.#db.exec("ALTER TABLE jobs ADD COLUMN lease_token TEXT"); if (!columns.has("lease_generation")) this.#db.exec("ALTER TABLE jobs ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0");
  }
  enqueue(job: SchedulerEnqueueInput, now: number): string {
    const projected = job.observations.map(normalizeObservationReference); const inputSourceDigest = digestObservations(projected);
    if (this.#db.prepare("SELECT 1 FROM completed_sources WHERE repository_id=? AND scope=? AND source_digest=?").get(job.repositoryId, job.scope, inputSourceDigest)) return job.jobId;
    const active = this.#db.prepare("SELECT job_id FROM jobs WHERE repository_id=? AND scope=? AND source_digest=?").get(job.repositoryId, job.scope, inputSourceDigest) as { job_id: string } | undefined; if (active) return active.job_id;
    this.#db.exec("BEGIN IMMEDIATE"); try {
      const rows = this.#db.prepare("SELECT observation_refs,available_at FROM jobs WHERE repository_id=? AND scope=? AND status='pending'").all(job.repositoryId, job.scope) as Array<{ observation_refs: string; available_at: number }>;
      const observations = [...projected, ...rows.flatMap((row) => (JSON.parse(row.observation_refs) as unknown[]).map(normalizeObservationReference))]; const unique = [...new Map(observations.map((item) => [`${item.observationId}\0${item.digest}\0${item.scope}\0${item.provenance}`, item])).values()];
      const sourceDigest = digestObservations(unique);
      this.#db.prepare("DELETE FROM jobs WHERE repository_id=? AND scope=? AND status='pending'").run(job.repositoryId, job.scope);
      this.#db.prepare(`INSERT INTO jobs(job_id,repository_id,scope,trigger,source_digest,checkpoint,observation_refs,status,attempt,available_at,lease_until,lease_token,lease_generation,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',0,?,NULL,NULL,0,?,?)`).run(job.jobId, job.repositoryId, job.scope, job.trigger, sourceDigest, job.checkpoint, JSON.stringify(unique), Math.min(job.availableAt, ...rows.map((row) => row.available_at)), now, now); this.#db.exec("COMMIT"); return job.jobId;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  claim(now: number, leaseMs: number): SchedulerJob | null {
    this.#db.exec("BEGIN IMMEDIATE"); try {
      const row = this.#db.prepare(`SELECT * FROM jobs WHERE (status='pending' OR (status='leased' AND lease_until<=?)) AND available_at<=? ORDER BY CASE trigger WHEN 'manual' THEN 0 WHEN 'compaction' THEN 1 ELSE 2 END,available_at,job_id LIMIT 1`).get(now, now) as Row | undefined;
      if (!row) { this.#db.exec("COMMIT"); return null; }
      const busy = this.#db.prepare(`SELECT 1 FROM jobs WHERE repository_id=? AND scope=? AND status='leased' AND lease_until>? AND job_id<>?`).get(row.repository_id, row.scope, now, row.job_id); if (busy) { this.#db.exec("COMMIT"); return null; }
      const token = randomUUID(); const generation = row.lease_generation + 1; this.#db.prepare("UPDATE jobs SET status='leased',lease_until=?,lease_token=?,lease_generation=?,updated_at=? WHERE job_id=?").run(now + leaseMs, token, generation, now, row.job_id); this.#db.exec("COMMIT"); return fromRow({ ...row, lease_until: now + leaseMs, lease_token: token, lease_generation: generation });
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  finish(job: SchedulerJob, outcome: MemoryRunOutcome, details: { reasonCode?: string; batchId?: string; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }; refusalFingerprint?: string }, now: number, retryAt?: number): boolean {
    if (!job.leaseToken) return false; this.#db.exec("BEGIN IMMEDIATE"); try {
      const owned = this.#db.prepare("SELECT 1 FROM jobs WHERE job_id=? AND status='leased' AND lease_token=? AND lease_generation=?").get(job.jobId, job.leaseToken, job.leaseGeneration); if (!owned) { this.#db.exec("COMMIT"); return false; }
      this.#db.prepare("INSERT INTO runs(job_id,outcome,reason_code,batch_id,usage_input,usage_output,usage_total,refusal_fingerprint,finished_at) VALUES(?,?,?,?,?,?,?,?,?)").run(job.jobId, outcome, details.reasonCode ?? null, details.batchId ?? null, details.usage?.inputTokens ?? null, details.usage?.outputTokens ?? null, details.usage?.totalTokens ?? null, details.refusalFingerprint ?? null, now);
      if (retryAt === undefined) { this.#db.prepare("INSERT OR IGNORE INTO completed_sources(repository_id,scope,source_digest,finished_at) VALUES(?,?,?,?)").run(job.repositoryId, job.scope, job.sourceDigest, now); this.#db.prepare("DELETE FROM jobs WHERE job_id=? AND lease_token=? AND lease_generation=?").run(job.jobId, job.leaseToken, job.leaseGeneration); }
      else this.#db.prepare("UPDATE jobs SET status='pending',attempt=attempt+1,available_at=?,lease_until=NULL,lease_token=NULL,updated_at=? WHERE job_id=? AND lease_token=? AND lease_generation=?").run(retryAt, now, job.jobId, job.leaseToken, job.leaseGeneration);
      this.#db.exec("COMMIT"); return true;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  pendingCount(): number { return Number((this.#db.prepare("SELECT count(*) count FROM jobs").get() as { count: number }).count); }
  close(): void { this.#db.close(); }
  [Symbol.dispose](): void { this.close(); }
}
interface Row { job_id: string; repository_id: string; scope: string; trigger: string; source_digest: string; checkpoint: string | null; observation_refs: string; attempt: number; available_at: number; lease_until: number | null; lease_token: string | null; lease_generation: number }
function fromRow(row: Row): SchedulerJob { return { jobId: row.job_id, repositoryId: row.repository_id, scope: row.scope, trigger: row.trigger, sourceDigest: row.source_digest, checkpoint: row.checkpoint, observations: (JSON.parse(row.observation_refs) as unknown[]).map(normalizeObservationReference), attempt: row.attempt, availableAt: row.available_at, leaseUntil: row.lease_until, leaseToken: row.lease_token, leaseGeneration: row.lease_generation }; }
function digestObservations(observations: readonly ObservationReference[]): string { return sourceDigest(observations.map((item) => ({ observation_id: item.observationId, observation_digest: item.digest, scope: item.scope, provenance: item.provenance }))); }
