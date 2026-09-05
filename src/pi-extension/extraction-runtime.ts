import type { RuntimeStore } from "../v2/runtime.js";

export interface SessionUserEntry { id: string; text: string; timestamp: number }
export interface PiWriter { store: RuntimeStore; run(options?: {force?: boolean; signal?: AbortSignal}): Promise<unknown>; close(): void }
/** Host lifecycle adapter. Delivery, rather than successful assistant completion, is evidence. */
export class PiCaptureRuntime {
  readonly #writer: PiWriter;
  readonly #abort = new AbortController();
  readonly #timer: ReturnType<typeof setInterval>;
  #stable = false;
  #closed = false;
  #running: Promise<unknown> | undefined;
  constructor(writer: PiWriter) {
    this.#writer = writer;
    this.#timer = setInterval(() => this.check(), 1000);
    this.#timer.unref();
  }
  start(sessionId: string, entries: SessionUserEntry[]): void { this.bind(sessionId, entries); this.#stable = true; this.check(); }
  input(input: {sessionId:string;text:string;source:string;scope:string;streamingBehavior?:"steer"|"followUp";parentEntryId?:string|null;hasUnsupportedContent?:boolean}): void { this.#writer.store.stageInput(input); }
  delivered(sessionId:string,text:string,timestamp:number,hasUnsupportedContent=false): void { this.#writer.store.delivered(sessionId,text,timestamp,hasUnsupportedContent); }
  bind(sessionId:string,entries:SessionUserEntry[]): void { this.#writer.store.bind(sessionId,entries); }
  cancelInputs(sessionId:string): void { this.#writer.store.cancelInputs(sessionId); }
  busy(): void { this.#stable = false; }
  settled(sessionId:string,entries:SessionUserEntry[]): void { this.bind(sessionId,entries); this.cancelInputs(sessionId); this.#stable = true; this.check(); }
  flush(): void { this.#writer.store.requestFlush(); this.check(); }
  check(): void {
    if (this.#closed || !this.#stable || this.#running) return;
    this.#running = this.#writer.run({signal:this.#abort.signal}).then(result => {
      if (result && typeof result === 'object' && 'outcome' in result && result.outcome === 'failed') process.stderr.write('[common-memory] maintenance failed; inspect common-memory status for the diagnostic code.\n');
    }).catch(() => {
      process.stderr.write("[common-memory] maintenance failed; durable queue retained. Run common-memory status.\n");
    }).finally(() => { this.#running = undefined; if (this.#closed) this.#writer.close(); });
  }
  shutdown(): void {
    if (this.#closed) return;
    this.#writer.store.requestFlush(); this.#closed = true; clearInterval(this.#timer); this.#abort.abort();
    if (!this.#running) this.#writer.close();
  }
}
