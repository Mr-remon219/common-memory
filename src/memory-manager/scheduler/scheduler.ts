import { createHash, randomUUID } from "node:crypto";
import { sourceDigest } from "../../core/governance/governance-digest.js";
import { normalizeObservationReference } from "../contracts/observation.js";
import type { MemoryManager } from "../memory-manager.js";
import type { MemoryRunResult } from "../contracts/run.js";
import { MemoryManagerJobStore } from "./job-store.js";
import { shouldEnqueue, type SchedulerTrigger } from "./triggers.js";
import { schedulerClock, type SchedulerClock } from "./timing.js";
export interface MemoryManagerSchedulerOptions { manager: MemoryManager; store: MemoryManagerJobStore; clock?: SchedulerClock; leaseMs?: number; maxAttempts?: number }
export class MemoryManagerScheduler {
  readonly #manager: MemoryManager; readonly #store: MemoryManagerJobStore; readonly #clock: SchedulerClock; readonly #leaseMs: number; readonly #maxAttempts: number; #paused = false; #controller: AbortController | null = null;
  constructor(options: MemoryManagerSchedulerOptions) { this.#manager = options.manager; this.#store = options.store; this.#clock = options.clock ?? schedulerClock; this.#leaseMs = options.leaseMs ?? 60_000; this.#maxAttempts = options.maxAttempts ?? 5; }
  enqueue(trigger: SchedulerTrigger): string | null { const now = this.#clock.now(); const observations = trigger.observations.map(normalizeObservationReference); const normalized = { ...trigger, observations }; const decision = shouldEnqueue(normalized, now); if (!decision.enqueue) return null; const digestValue = sourceDigest(observations.map((item) => ({ observation_id: item.observationId, observation_digest: item.digest, scope: item.scope, provenance: item.provenance }))); const jobId = `job.${digest([trigger.repositoryId, trigger.scope, digestValue, trigger.checkpoint ?? ""]).slice(0, 32)}`; return this.#store.enqueue({ jobId, repositoryId: trigger.repositoryId, scope: trigger.scope, trigger: trigger.origin, checkpoint: trigger.checkpoint ?? null, observations, availableAt: now.getTime() + decision.delayMs }, now.getTime()); }
  async runOnce(): Promise<MemoryRunResult | null> { if (this.#paused) return null; const now = this.#clock.now().getTime(); const job = this.#store.claim(now, this.#leaseMs); if (!job) return null; this.#controller = new AbortController(); let result: MemoryRunResult; try { result = await this.#manager.consolidate({ observations: job.observations, signal: this.#controller.signal }); } catch { result = { outcome: "failed", reason_code: "UNAVAILABLE" }; } finally { this.#controller = null; }
    const retryable = new Set(["UNAVAILABLE", "RATE_LIMITED", "TIMEOUT", "STALE_REVISION"]).has(result.reason_code ?? "") || result.outcome === "deferred" || result.outcome === "cancelled"; const retryAt = retryable && job.attempt + 1 < this.#maxAttempts ? this.#clock.now().getTime() + Math.min(3_600_000, 1_000 * 2 ** job.attempt) : undefined;
    this.#store.finish(job, result.outcome, { ...(result.reason_code ? { reasonCode: result.reason_code } : {}), ...(result.batch ? { batchId: result.batch.batch_id } : {}), ...(result.usage ? { usage: result.usage } : {}), ...(result.refusal ? { refusalFingerprint: result.refusal.fingerprint } : {}) }, this.#clock.now().getTime(), retryAt); return result; }
  pause(): void { this.#paused = true; this.#controller?.abort(); }
  resume(): void { this.#paused = false; }
  stop(): void { this.pause(); }
  get paused(): boolean { return this.#paused; }
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex"); }
export function createSchedulerId(): string { return `scheduler.${randomUUID()}`; }
