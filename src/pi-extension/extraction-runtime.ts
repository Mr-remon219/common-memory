import { scanFields } from "../core/safety/scanner.js";
import type { MemoryRunInput } from "../memory-manager/memory-manager.js";
import type { MemoryRunResult } from "../memory-manager/contracts/run.js";
import { PiExtractionStore, type PiSessionUserEntry } from "./extraction-store.js";

const RETRYABLE_CODES = new Set(["UNAVAILABLE", "RATE_LIMITED", "TIMEOUT", "STALE_REVISION", "CANCELLED"]);
const EXPLICIT_GLOBAL_MEMORY = /(?:^|[。！？.!?]\s*)(?:请)?(?:记住|记得)|(?:从现在起|以后)(?:请|都|总是|默认|不要)|我(?:更)?(?:喜欢|偏好|习惯)|我的(?:长期)?(?:偏好|习惯|要求|边界)(?:是|为|：|:)|默认(?:使用|用)|(?:please\s+)?remember\b|from now on\b|i (?:prefer|like)\b|my (?:long[- ]term )?(?:preference|boundary|requirement) is\b/iu;
const PROJECT_LOCAL_MEMORY = /(?:这个|本)(?:项目|仓库|代码库)|this (?:project|repository|repo)|the current (?:project|repository|repo)/iu;
const EXPLICIT_GOVERNANCE = /(?:^|[。！？.!?]\s*)(?:不对|更正|纠正|修正一下|其实不是|actually\b|correction\b)|(?:忘记|删除|清除)(?:之前|这条|关于|该|那条)?(?:记忆|偏好|事实|内容)|(?:forget|delete|remove)\s+(?:that|this|the memory|my previous)/iu;

export interface PiExtractionManager {
  extract(input: MemoryRunInput): Promise<MemoryRunResult>;
}

export interface PiExtractionRuntimeOptions {
  store: PiExtractionStore;
  managerFactory: (scope: string) => PiExtractionManager;
  allowedScopes: readonly string[];
  now?: () => Date;
  batchSize?: number;
  idleDelayMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  extractDeadlineMs?: number;
  staleCaptureMs?: number;
}

export interface PiInputCapture {
  sessionId: string;
  parentEntryId: string | null;
  text: string;
  source: "interactive" | "rpc" | "extension";
  streamingBehavior?: "steer" | "followUp";
  hasImages: boolean;
}

export interface PiExtractionLifecycle {
  start(sessionId: string, successfulBranchUsers: readonly PiSessionUserEntry[]): void;
  stageInput(input: PiInputCapture): boolean;
  acceptPrompt(sessionId: string, expandedPrompt: string): boolean;
  confirmUserMessage(sessionId: string, actualText: string, timestamp: number): boolean;
  recordAgentEnd(sessionId: string, messages: readonly unknown[]): void;
  settle(sessionId: string, successfulBranchUsers: readonly PiSessionUserEntry[]): void;
  shutdown(timeoutMs?: number): Promise<void>;
}

export class PiExtractionRuntime implements PiExtractionLifecycle {
  readonly #store: PiExtractionStore;
  readonly #managerFactory: (scope: string) => PiExtractionManager;
  readonly #allowedScopes: readonly string[];
  readonly #now: () => Date;
  readonly #batchSize: number;
  readonly #idleDelayMs: number;
  readonly #leaseMs: number;
  readonly #maxAttempts: number;
  readonly #extractDeadlineMs: number;
  readonly #staleCaptureMs: number;
  readonly #lastRunSuccessful = new Map<string, boolean>();
  #timer: NodeJS.Timeout | null = null;
  #timerDueAt: number | null = null;
  #running: Promise<MemoryRunResult | null> | null = null;
  #controller: AbortController | null = null;
  #started = false;
  #stopping = false;
  #closed = false;

  constructor(options: PiExtractionRuntimeOptions) {
    if (options.allowedScopes.length === 0) throw new TypeError("Pi extraction requires at least one allowed scope");
    this.#store = options.store;
    this.#managerFactory = options.managerFactory;
    this.#allowedScopes = Object.freeze([...options.allowedScopes]);
    this.#now = options.now ?? (() => new Date());
    this.#batchSize = positiveInteger(options.batchSize ?? 3, "batchSize");
    this.#idleDelayMs = nonNegativeInteger(options.idleDelayMs ?? 30_000, "idleDelayMs");
    this.#leaseMs = positiveInteger(options.leaseMs ?? 60_000, "leaseMs");
    this.#maxAttempts = positiveInteger(options.maxAttempts ?? 5, "maxAttempts");
    this.#extractDeadlineMs = positiveInteger(options.extractDeadlineMs ?? 1_500, "extractDeadlineMs");
    this.#staleCaptureMs = nonNegativeInteger(options.staleCaptureMs ?? 86_400_000, "staleCaptureMs");
  }

  start(sessionId: string, successfulBranchUsers: readonly PiSessionUserEntry[]): void {
    if (this.#closed || this.#stopping) return;
    const now = this.#now().getTime();
    this.#store.finalizeSettled(sessionId, successfulBranchUsers, true, now, this.#batchSize, this.#idleDelayMs);
    this.#store.pruneUnconfirmed(now - this.#staleCaptureMs);
    this.#started = true;
    this.#schedule();
  }

  stageInput(input: PiInputCapture): boolean {
    if (this.#closed || this.#stopping || input.source === "extension" || input.streamingBehavior !== undefined || input.hasImages) return false;
    if (EXPLICIT_GOVERNANCE.test(input.text)) return false;
    const scope = captureScope(input.text, this.#allowedScopes);
    if (!scope) return false;
    try { scanFields([{ path: "/pi/input", value: input.text }]); } catch { return false; }
    const now = this.#now();
    return this.#store.stage({ sessionId: input.sessionId, parentEntryId: input.parentEntryId, text: input.text, scope, source: input.source, observedAt: now.toISOString(), nowMs: now.getTime() }) !== null;
  }

  acceptPrompt(sessionId: string, expandedPrompt: string): boolean {
    if (this.#closed || this.#stopping) return false;
    return this.#store.acceptLatest(sessionId, expandedPrompt, this.#now().getTime());
  }

  confirmUserMessage(sessionId: string, actualText: string, timestamp: number): boolean {
    if (this.#closed || this.#stopping) return false;
    return this.#store.confirmNext(sessionId, actualText, timestamp, this.#now().getTime());
  }

  recordAgentEnd(sessionId: string, messages: readonly unknown[]): void {
    if (this.#closed || this.#stopping) return;
    this.#lastRunSuccessful.set(sessionId, terminalAssistantSucceeded(messages));
  }

  settle(sessionId: string, successfulBranchUsers: readonly PiSessionUserEntry[]): void {
    if (this.#closed || this.#stopping) return;
    const successful = this.#lastRunSuccessful.get(sessionId) === true;
    this.#lastRunSuccessful.delete(sessionId);
    this.#store.finalizeSettled(sessionId, successfulBranchUsers, successful, this.#now().getTime(), this.#batchSize, this.#idleDelayMs);
    this.#schedule();
  }

  runDueOnce(): Promise<MemoryRunResult | null> {
    if (this.#closed || this.#stopping) return Promise.resolve(null);
    if (this.#running) return this.#running;
    const running = this.#runOne();
    this.#running = running;
    const settled = (): void => { if (this.#running === running) this.#running = null; this.#controller = null; this.#schedule(); };
    void running.then(settled, settled);
    return running;
  }

  async shutdown(timeoutMs = 750): Promise<void> {
    if (this.#closed) return;
    this.#stopping = true;
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; this.#timerDueAt = null; }
    this.#controller?.abort();
    const running = this.#running;
    if (!running) { this.#close(); return; }
    let finished = false;
    const completion = running.then(() => { finished = true; }, () => { finished = true; });
    await Promise.race([
      completion,
      new Promise<void>((resolve) => { const timer = setTimeout(resolve, Math.max(0, timeoutMs)); timer.unref?.(); }),
    ]);
    if (finished) this.#close();
    else void completion.then(() => this.#close());
  }

  async #runOne(): Promise<MemoryRunResult | null> {
    const now = this.#now().getTime();
    const job = this.#store.claim(now, this.#leaseMs);
    if (!job) return null;
    const controller = new AbortController(); this.#controller = controller;
    let result: MemoryRunResult;
    try {
      result = await this.#managerFactory(job.scope).extract({ observations: job.observations, signal: controller.signal, deadlineMs: this.#extractDeadlineMs });
    } catch (error) {
      result = controller.signal.aborted || error instanceof DOMException && error.name === "AbortError" ? { outcome: "cancelled", reason_code: "CANCELLED" } : { outcome: "deferred", reason_code: "UNAVAILABLE" };
    }
    const finishedAt = this.#now().getTime();
    const retryable = result.outcome === "deferred" || result.outcome === "cancelled" || RETRYABLE_CODES.has(result.reason_code ?? "");
    const retryAt = retryable && job.attempt + 1 < this.#maxAttempts ? finishedAt + Math.min(3_600_000, 1_000 * 2 ** job.attempt) : undefined;
    this.#store.finish(job, result, finishedAt, retryAt);
    return result;
  }

  #schedule(): void {
    if (!this.#started || this.#closed || this.#stopping || this.#running) return;
    const availableAt = this.#store.nextAvailableAt();
    if (availableAt === null) return;
    if (this.#timer && this.#timerDueAt !== null && this.#timerDueAt <= availableAt) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timerDueAt = availableAt;
    const delay = Math.max(0, availableAt - this.#now().getTime());
    this.#timer = setTimeout(() => { this.#timer = null; this.#timerDueAt = null; void this.runDueOnce().catch(() => undefined); }, delay);
    this.#timer.unref?.();
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#store.close();
  }
}

function captureScope(text: string, allowedScopes: readonly string[]): string | null {
  const projects = allowedScopes.filter((scope) => scope.startsWith("project:"));
  const project = projects.length === 1 ? projects[0] : undefined;
  if (PROJECT_LOCAL_MEMORY.test(text)) return project ?? null;
  if (project && !EXPLICIT_GLOBAL_MEMORY.test(text)) return project;
  if (allowedScopes.includes("global") && EXPLICIT_GLOBAL_MEMORY.test(text)) return "global";
  return project ?? null;
}

function positiveInteger(value: number, name: string): number { if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`); return value; }
function nonNegativeInteger(value: number, name: string): number { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`); return value; }

function terminalAssistantSucceeded(messages: readonly unknown[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const value = messages[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const message = value as Record<string, unknown>;
    if (message.role === "assistant") return message.stopReason === "stop";
  }
  return false;
}
