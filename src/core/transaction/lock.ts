import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoreError } from "../contracts/errors.js";
import type { FaultInjector } from "../contracts/ports.js";
import { noFaults } from "../contracts/ports.js";
import { assertFilePathBeforeOpen, assertOpenedFileIdentity } from "../repository/path-safety.js";

export class RepositoryLock implements Disposable {
  readonly #db: DatabaseSync;
  #held = false; readonly #faults: FaultInjector;
  constructor(path: string, timeoutMs = 2_000, faults: FaultInjector = noFaults, dataRoot = dirname(dirname(path))) {
    this.#faults = faults;
    assertFilePathBeforeOpen(dataRoot, path); let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { timeout: timeoutMs }); assertOpenedFileIdentity(dataRoot, path);
      db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS repository_lock (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL); INSERT OR IGNORE INTO repository_lock VALUES(1, 1);");
      db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(timeoutMs))}; BEGIN IMMEDIATE;`); this.#db = db; this.#held = true;
    } catch (error) {
      try { db?.close(); } catch { /* Preserve the stable lock error below. */ }
      const message = error instanceof Error ? error.message : "";
      if (/busy|locked/i.test(message)) throw new CoreError("STORE_LOCKED", "The memory repository is locked", {}, { cause: error });
      throw new CoreError("STORE_UNAVAILABLE", "The repository lock is unavailable", {}, { cause: error });
    }
  }
  close(): void { if (this.#held) { let injected: unknown; try { this.#faults.checkpoint("lock-release"); } catch (error) { injected = error; } try { this.#db.exec("COMMIT"); } finally { this.#held = false; this.#db.close(); } if (injected) throw injected; } }
  [Symbol.dispose](): void { this.close(); }
}
