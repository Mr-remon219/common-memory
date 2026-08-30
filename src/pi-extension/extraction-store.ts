import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ObservationReference, ObservationSourcePort, ResolvedObservation } from "../memory-manager/contracts/observation.js";
import { normalizeObservationReference } from "../memory-manager/contracts/observation.js";
import type { MemoryRunResult } from "../memory-manager/contracts/run.js";

const CAPTURE_STATES = ["staged", "accepted", "confirmed", "queued", "completed", "dead_letter"] as const;
type CaptureState = typeof CAPTURE_STATES[number];

export interface PiCaptureInput {
  sessionId: string;
  parentEntryId: string | null;
  text: string;
  scope: string;
  source: "interactive" | "rpc";
  observedAt: string;
  nowMs: number;
}

export interface PiSessionUserEntry {
  entryId: string;
  parentEntryId: string | null;
  text: string;
  timestamp: number;
}

export interface PiExtractJob {
  jobId: string;
  sessionId: string;
  scope: string;
  observations: ObservationReference[];
  attempt: number;
  availableAt: number;
  leaseUntil: number | null;
  leaseToken: string | null;
  leaseGeneration: number;
}

export interface PiExtractionStoreOptions {
  maxObservationBytes?: number;
  acceptanceWindowMs?: number;
}

export class PiExtractionStore implements ObservationSourcePort, Disposable {
  readonly #db: DatabaseSync;
  readonly #maxObservationBytes: number;
  readonly #acceptanceWindowMs: number;
  #closed = false;

  constructor(stateRoot: string, options: PiExtractionStoreOptions = {}) {
    const maxObservationBytes = options.maxObservationBytes ?? 4_000;
    const acceptanceWindowMs = options.acceptanceWindowMs ?? 5_000;
    if (!Number.isSafeInteger(maxObservationBytes) || maxObservationBytes < 1) throw new TypeError("maxObservationBytes must be a positive integer");
    if (!Number.isSafeInteger(acceptanceWindowMs) || acceptanceWindowMs < 0) throw new TypeError("acceptanceWindowMs must be a non-negative integer");
    const root = resolve(stateRoot);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) throw new Error("Pi extraction stateRoot must be a real local directory");
    const path = join(root, "pi-extraction.sqlite");
    this.#db = new DatabaseSync(path);
    try { chmodSync(path, 0o600); } catch { /* Windows ACLs are managed by the OS. */ }
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS captures(
        capture_id TEXT PRIMARY KEY,
        observation_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        parent_entry_id TEXT,
        source_entry_id TEXT,
        text TEXT NOT NULL,
        digest TEXT NOT NULL,
        scope TEXT NOT NULL,
        provenance TEXT NOT NULL CHECK(provenance='user_statement'),
        source TEXT NOT NULL CHECK(source IN ('interactive','rpc')),
        state TEXT NOT NULL CHECK(state IN ('staged','accepted','confirmed','queued','completed','dead_letter')),
        observed_at TEXT NOT NULL,
        accepted_prompt_digest TEXT,
        actual_message_digest TEXT,
        actual_message_timestamp INTEGER,
        job_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(session_id,source_entry_id)
      );
      CREATE INDEX IF NOT EXISTS captures_session_state ON captures(session_id,state,created_at,capture_id);
      CREATE TABLE IF NOT EXISTS pi_session_watermarks(
        session_id TEXT PRIMARY KEY,
        source_entry_id TEXT NOT NULL,
        settled_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS extract_jobs(
        job_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        observation_refs TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','leased','dead_letter')),
        attempt INTEGER NOT NULL,
        available_at INTEGER NOT NULL,
        lease_until INTEGER,
        lease_token TEXT,
        lease_generation INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS extract_jobs_claim ON extract_jobs(status,available_at,lease_until);
      CREATE TABLE IF NOT EXISTS extract_runs(
        run_id INTEGER PRIMARY KEY,
        job_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason_code TEXT,
        batch_id TEXT,
        usage_input INTEGER,
        usage_output INTEGER,
        usage_total INTEGER,
        refusal_fingerprint TEXT,
        finished_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS completed_extract_sources(
        source_digest TEXT PRIMARY KEY,
        finished_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pi_extraction_schema(version INTEGER NOT NULL);
      INSERT INTO pi_extraction_schema(version) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM pi_extraction_schema);
    `);
    const schema = this.#db.prepare("SELECT version FROM pi_extraction_schema").all() as Array<{ version: number }>;
    if (schema.length !== 1 || schema[0]?.version !== 1) throw new Error("Unsupported Pi extraction schema version");
    this.#maxObservationBytes = maxObservationBytes;
    this.#acceptanceWindowMs = acceptanceWindowMs;
  }

  stage(input: PiCaptureInput): ObservationReference | null {
    this.#assertOpen();
    const text = input.text;
    if (Buffer.byteLength(text, "utf8") > this.#maxObservationBytes || !eligible(text.trim(), this.#maxObservationBytes)) return null;
    const captureId = `capture_${randomUUID().replaceAll("-", "")}`;
    const observationId = `pi_${hash(`${input.sessionId}\0${captureId}`).slice(0, 40)}`;
    const digest = digestText(text);
    return this.#transaction(() => {
      this.#db.prepare("DELETE FROM captures WHERE session_id=? AND state='staged'").run(input.sessionId);
      this.#db.prepare(`INSERT INTO captures(capture_id,observation_id,session_id,parent_entry_id,text,digest,scope,provenance,source,state,observed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'user_statement',?,'staged',?,?,?)`).run(captureId, observationId, input.sessionId, input.parentEntryId, text, digest, input.scope, input.source, input.observedAt, input.nowMs, input.nowMs);
      return Object.freeze({ observationId, digest, scope: input.scope, provenance: "user_statement" });
    });
  }

  acceptLatest(sessionId: string, prompt: string, nowMs: number): boolean {
    this.#assertOpen();
    const rows = this.#db.prepare("SELECT capture_id,text,created_at FROM captures WHERE session_id=? AND state='staged' AND created_at>=? ORDER BY created_at DESC,capture_id DESC").all(sessionId, nowMs - this.#acceptanceWindowMs) as Array<{ capture_id: string; text: string; created_at: number }>;
    if (rows.length === 0) return false;
    const normalized = prompt.trim();
    const row = rows.find((candidate) => candidate.text.trim() === normalized);
    if (!row) return false;
    const result = this.#db.prepare("UPDATE captures SET state='accepted',accepted_prompt_digest=?,updated_at=? WHERE capture_id=? AND state='staged'").run(digestText(normalized), nowMs, row.capture_id);
    return result.changes === 1;
  }

  confirmNext(sessionId: string, actualText: string, timestamp: number, nowMs: number): boolean {
    this.#assertOpen();
    const row = this.#db.prepare("SELECT capture_id FROM captures WHERE session_id=? AND state='accepted' ORDER BY created_at,capture_id LIMIT 1").get(sessionId) as { capture_id: string } | undefined;
    if (!row) return false;
    const result = this.#db.prepare("UPDATE captures SET state='confirmed',actual_message_digest=?,actual_message_timestamp=?,updated_at=? WHERE capture_id=? AND state='accepted'").run(digestText(actualText), timestamp, nowMs, row.capture_id);
    return result.changes === 1;
  }

  finalizeSettled(sessionId: string, branch: readonly PiSessionUserEntry[], successful: boolean, nowMs: number, batchSize: number, idleDelayMs: number): string | null {
    this.#assertOpen();
    return this.#transaction(() => {
      if (!successful) {
        this.#db.prepare("DELETE FROM captures WHERE session_id=? AND state IN ('staged','accepted','confirmed')").run(sessionId);
        return null;
      }
      this.#db.prepare("DELETE FROM captures WHERE session_id=? AND state IN ('staged','accepted')").run(sessionId);
      const confirmed = this.#db.prepare("SELECT capture_id,parent_entry_id,digest,actual_message_digest,actual_message_timestamp FROM captures WHERE session_id=? AND state='confirmed' ORDER BY created_at,capture_id").all(sessionId) as Array<{ capture_id: string; parent_entry_id: string | null; digest: string; actual_message_digest: string; actual_message_timestamp: number }>;
      const validatedBranch = branch.filter((entry) => entry.entryId.length > 0 && entry.entryId.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(entry.entryId) && Number.isFinite(entry.timestamp));
      const watermark = validatedBranch.at(-1);
      const available = [...validatedBranch];
      for (const capture of confirmed) {
        const index = available.findIndex((entry) => entry.parentEntryId === capture.parent_entry_id && entry.timestamp === capture.actual_message_timestamp && digestText(entry.text) === capture.actual_message_digest);
        if (index < 0) continue;
        const entry = available.splice(index, 1)[0]!;
        const duplicate = this.#db.prepare("SELECT capture_id FROM captures WHERE session_id=? AND source_entry_id=? AND capture_id<>?").get(sessionId, entry.entryId, capture.capture_id);
        if (duplicate) { this.#db.prepare("DELETE FROM captures WHERE capture_id=?").run(capture.capture_id); continue; }
        const observationId = `pi_${hash(`${sessionId}\0${entry.entryId}\0${capture.digest}`).slice(0, 40)}`;
        this.#db.prepare("UPDATE captures SET source_entry_id=?,observation_id=?,updated_at=? WHERE capture_id=? AND state='confirmed'").run(entry.entryId, observationId, nowMs, capture.capture_id);
      }
      this.#db.prepare("DELETE FROM captures WHERE session_id=? AND state='confirmed' AND source_entry_id IS NULL").run(sessionId);
      if (watermark) this.#db.prepare("INSERT INTO pi_session_watermarks(session_id,source_entry_id,settled_at) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET source_entry_id=excluded.source_entry_id,settled_at=excluded.settled_at").run(sessionId, watermark.entryId, nowMs);
      const captures = this.#db.prepare("SELECT capture_id,observation_id,digest,scope,provenance FROM captures WHERE session_id=? AND state='confirmed' AND source_entry_id IS NOT NULL ORDER BY created_at,capture_id").all(sessionId) as unknown as CaptureRow[];
      if (captures.length === 0) return null;
      const grouped = new Map<string, CaptureRow[]>();
      for (const row of captures) grouped.set(row.scope, [...(grouped.get(row.scope) ?? []), row]);
      let firstJob: string | null = null;
      for (const [scope, rows] of grouped) {
        const pending = this.#db.prepare("SELECT job_id,observation_refs,available_at FROM extract_jobs WHERE session_id=? AND scope=? AND status='pending' ORDER BY created_at,job_id LIMIT 1").get(sessionId, scope) as { job_id: string; observation_refs: string; available_at: number } | undefined;
        const existing = pending ? parseReferences(pending.observation_refs) : [];
        const observations = uniqueReferences([...existing, ...rows.map(toReference)]);
        const source = referencesDigest(observations);
        const availableAt = observations.length >= batchSize ? nowMs : Math.min(pending?.available_at ?? Number.POSITIVE_INFINITY, nowMs + idleDelayMs);
        const jobId = pending?.job_id ?? `extract_${randomUUID().replaceAll("-", "")}`;
        if (pending) this.#db.prepare("UPDATE extract_jobs SET source_digest=?,observation_refs=?,available_at=?,updated_at=? WHERE job_id=? AND status='pending'").run(source, JSON.stringify(observations), availableAt, nowMs, jobId);
        else this.#db.prepare("INSERT INTO extract_jobs(job_id,session_id,scope,source_digest,observation_refs,status,attempt,available_at,lease_until,lease_token,lease_generation,created_at,updated_at) VALUES(?,?,?,?,?,'pending',0,?,NULL,NULL,0,?,?)").run(jobId, sessionId, scope, source, JSON.stringify(observations), availableAt, nowMs, nowMs);
        this.#db.prepare(`UPDATE captures SET state='queued',job_id=?,updated_at=? WHERE capture_id IN (${placeholders(rows.length)})`).run(jobId, nowMs, ...rows.map((row) => row.capture_id));
        firstJob ??= jobId;
      }
      return firstJob;
    });
  }

  pruneUnconfirmed(beforeMs: number): number {
    this.#assertOpen();
    return Number(this.#db.prepare("DELETE FROM captures WHERE state IN ('staged','accepted') AND created_at<?").run(beforeMs).changes);
  }

  claim(nowMs: number, leaseMs: number): PiExtractJob | null {
    this.#assertOpen();
    return this.#transaction(() => {
      const row = this.#db.prepare("SELECT j.* FROM extract_jobs j WHERE (j.status='pending' OR (j.status='leased' AND j.lease_until<=?)) AND j.available_at<=? AND NOT EXISTS(SELECT 1 FROM extract_jobs b WHERE b.session_id=j.session_id AND b.scope=j.scope AND b.status='leased' AND b.lease_until>? AND b.job_id<>j.job_id) ORDER BY j.available_at,j.job_id LIMIT 1").get(nowMs, nowMs, nowMs) as JobRow | undefined;
      if (!row) return null;
      const token = randomUUID(); const generation = row.lease_generation + 1;
      this.#db.prepare("UPDATE extract_jobs SET status='leased',lease_until=?,lease_token=?,lease_generation=?,updated_at=? WHERE job_id=?").run(nowMs + leaseMs, token, generation, nowMs, row.job_id);
      return fromJobRow({ ...row, lease_until: nowMs + leaseMs, lease_token: token, lease_generation: generation });
    });
  }

  finish(job: PiExtractJob, result: MemoryRunResult, nowMs: number, retryAt?: number): boolean {
    this.#assertOpen();
    if (!job.leaseToken) return false;
    return this.#transaction(() => {
      const owned = this.#db.prepare("SELECT source_digest FROM extract_jobs WHERE job_id=? AND status='leased' AND lease_token=? AND lease_generation=?").get(job.jobId, job.leaseToken, job.leaseGeneration) as { source_digest: string } | undefined;
      if (!owned) return false;
      this.#db.prepare("INSERT INTO extract_runs(job_id,outcome,reason_code,batch_id,usage_input,usage_output,usage_total,refusal_fingerprint,finished_at) VALUES(?,?,?,?,?,?,?,?,?)").run(job.jobId, result.outcome, result.reason_code ?? null, result.batch?.batch_id ?? null, result.usage?.inputTokens ?? null, result.usage?.outputTokens ?? null, result.usage?.totalTokens ?? null, result.refusal?.fingerprint ?? null, nowMs);
      if (retryAt !== undefined) this.#db.prepare("UPDATE extract_jobs SET status='pending',attempt=attempt+1,available_at=?,lease_until=NULL,lease_token=NULL,updated_at=? WHERE job_id=? AND lease_token=? AND lease_generation=?").run(retryAt, nowMs, job.jobId, job.leaseToken, job.leaseGeneration);
      else {
        const deadLetter = result.outcome === "deferred" || result.outcome === "cancelled" || result.outcome === "failed";
        if (deadLetter) {
          this.#db.prepare("UPDATE extract_jobs SET status='dead_letter',attempt=attempt+1,lease_until=NULL,lease_token=NULL,updated_at=? WHERE job_id=? AND lease_token=? AND lease_generation=?").run(nowMs, job.jobId, job.leaseToken, job.leaseGeneration);
          this.#db.prepare("UPDATE captures SET state='dead_letter',updated_at=? WHERE job_id=? AND state='queued'").run(nowMs, job.jobId);
        } else {
          this.#db.prepare("INSERT OR IGNORE INTO completed_extract_sources(source_digest,finished_at) VALUES(?,?)").run(owned.source_digest, nowMs);
          this.#db.prepare("UPDATE captures SET state='completed',updated_at=? WHERE job_id=? AND state='queued'").run(nowMs, job.jobId);
          this.#db.prepare("DELETE FROM extract_jobs WHERE job_id=? AND lease_token=? AND lease_generation=?").run(job.jobId, job.leaseToken, job.leaseGeneration);
        }
      }
      return true;
    });
  }

  nextAvailableAt(): number | null {
    this.#assertOpen();
    const row = this.#db.prepare("SELECT min(CASE WHEN j.status='leased' THEN j.lease_until ELSE max(j.available_at,coalesce((SELECT max(b.lease_until) FROM extract_jobs b WHERE b.session_id=j.session_id AND b.scope=j.scope AND b.status='leased'),j.available_at)) END) value FROM extract_jobs j WHERE j.status IN ('pending','leased')").get() as { value: number | null };
    return row.value;
  }

  pendingCount(): number {
    this.#assertOpen();
    return Number((this.#db.prepare("SELECT count(*) count FROM extract_jobs").get() as { count: number }).count);
  }

  async resolve(reference: ObservationReference, options: { signal?: AbortSignal } = {}): Promise<ResolvedObservation> {
    this.#assertOpen();
    const normalized = normalizeObservationReference(reference);
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const row = this.#db.prepare("SELECT observation_id,digest,scope,provenance,text,observed_at,session_id,source_entry_id FROM captures WHERE observation_id=? AND state IN ('queued','completed','dead_letter')").get(normalized.observationId) as ObservationRow | undefined;
    if (!row || !row.source_entry_id || row.digest !== normalized.digest || row.scope !== normalized.scope || row.provenance !== normalized.provenance || digestText(row.text) !== normalized.digest) throw new Error("Pi observation is unavailable or failed integrity verification");
    return Object.freeze({ ...normalized, text: row.text, observedAt: row.observed_at, sessionId: row.session_id, reference: `pi-session:${row.session_id}:${row.source_entry_id}` });
  }

  close(): void { if (!this.#closed) { this.#closed = true; this.#db.close(); } }
  [Symbol.dispose](): void { this.close(); }

  #transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.#db.exec("COMMIT"); return result; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  #assertOpen(): void { if (this.#closed) throw new Error("Pi extraction store is closed"); }
}

interface CaptureRow { capture_id: string; observation_id: string; digest: string; scope: string; provenance: string }
interface ObservationRow { observation_id: string; digest: string; scope: string; provenance: string; text: string; observed_at: string; session_id: string; source_entry_id: string | null }
interface JobRow { job_id: string; session_id: string; scope: string; observation_refs: string; attempt: number; available_at: number; lease_until: number | null; lease_token: string | null; lease_generation: number }

function toReference(row: CaptureRow): ObservationReference { return normalizeObservationReference({ observationId: row.observation_id, digest: row.digest, scope: row.scope, provenance: row.provenance }); }
function parseReferences(value: string): ObservationReference[] { const parsed = JSON.parse(value) as unknown; if (!Array.isArray(parsed)) throw new Error("Invalid extract job observation references"); return parsed.map(normalizeObservationReference); }
function uniqueReferences(values: readonly ObservationReference[]): ObservationReference[] { return [...new Map(values.map((item) => [`${item.observationId}\0${item.digest}\0${item.scope}\0${item.provenance}`, item])).values()]; }
function referencesDigest(values: readonly ObservationReference[]): string { return digestText(JSON.stringify([...values].sort((a, b) => a.observationId.localeCompare(b.observationId)))); }
function fromJobRow(row: JobRow): PiExtractJob { return { jobId: row.job_id, sessionId: row.session_id, scope: row.scope, observations: parseReferences(row.observation_refs), attempt: row.attempt, availableAt: row.available_at, leaseUntil: row.lease_until, leaseToken: row.lease_token, leaseGeneration: row.lease_generation }; }
function placeholders(count: number): string { if (!Number.isInteger(count) || count < 1) throw new Error("Expected at least one SQL placeholder"); return Array.from({ length: count }, () => "?").join(","); }
function digestText(value: string): string { return `sha256:${hash(value)}`; }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function eligible(text: string, maxBytes: number): boolean {
  if (text.length < 4 || /\0/u.test(text) || Buffer.byteLength(text, "utf8") > maxBytes) return false;
  if (/^\s*\/[A-Za-z][\w:-]*(?:\s|$)/u.test(text) || /```|^diff --git |^@@ /mu.test(text)) return false;
  const lowSignal = new Set(["ok", "okay", "yes", "no", "thanks", "thank you", "ping", "好的", "好", "嗯", "行", "可以", "谢谢", "收到", "继续"]);
  return !lowSignal.has(text.toLocaleLowerCase());
}

export const PI_CAPTURE_STATES: readonly CaptureState[] = CAPTURE_STATES;
