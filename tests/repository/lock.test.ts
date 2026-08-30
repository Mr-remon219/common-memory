import { spawn } from "node:child_process";
import { mkdirSync, renameSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { CoreService } from "../../src/core/service/core-service.js";
import { RepositoryLayout } from "../../src/core/repository/layout.js";
import { RepositoryLock } from "../../src/core/transaction/lock.js";
import { TestClock, TestIds, tempRoot } from "../helpers.js";
let cleanup: () => void = () => undefined; afterEach(() => cleanup());
it("does not let lock release faults escape a completed response", () => { const root = tempRoot(); cleanup = root.cleanup; const service = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids: new TestIds(), faults: { checkpoint(point) { if (point === "lock-release") throw new Error("release fault"); } } }); expect(service.initialize().ok).toBe(true); expect(service.diagnose().ok).toBe(true); });
it("fails a competing operation with STORE_LOCKED", () => {
  const root = tempRoot(); cleanup = root.cleanup; const service = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids: new TestIds(), lockTimeoutMs: 10 }); service.initialize();
  using held = new RepositoryLock(new RepositoryLayout(root.path).lockDatabase, 10); void held; const result = service.diagnose(); expect(!result.ok && result.error.code).toBe("STORE_LOCKED");
});
it.each(["state", "lock", "index"])("rejects a symlinked %s path", (kind) => { const root = tempRoot(); cleanup = root.cleanup; const outside = join(root.path, `outside-${kind}`); if (kind === "state") { mkdirSync(outside); symlinkSync(outside, join(root.path, "state"), process.platform === "win32" ? "junction" : "dir"); expect(new CoreService({ dataRoot: root.path, clock: new TestClock(), ids: new TestIds() }).initialize().ok).toBe(false); return; } const service = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids: new TestIds() }); if (kind === "lock") { mkdirSync(join(root.path, "state")); mkdirSync(join(root.path, "state", "transactions")); writeFileSync(outside, "x"); symlinkSync(outside, join(root.path, "state", "repository-lock.sqlite"), "file"); expect(service.initialize().ok).toBe(false); return; } service.initialize(); mkdirSync(outside); symlinkSync(outside, join(root.path, "index"), process.platform === "win32" ? "junction" : "dir"); expect(service.rebuildIndex().ok).toBe(false); });
it("rejects an oversized sparse authority YAML before reading", () => { const root = tempRoot(); cleanup = root.cleanup; const service = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids: new TestIds() }); service.initialize(); truncateSync(join(root.path, "repository", "repository.yaml"), 2_000_000); const result = service.diagnose(); expect(!result.ok && result.error.code).toBe("STORE_UNAVAILABLE"); });
it("rejects a symlinked repository memory component", () => { const root = tempRoot(); cleanup = root.cleanup; const service = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids: new TestIds() }); service.initialize(); const memory = join(root.path, "repository", "memory"); const backup = `${memory}-backup`; const outside = join(root.path, "outside"); mkdirSync(outside); renameSync(memory, backup); symlinkSync(outside, memory, process.platform === "win32" ? "junction" : "dir"); const result = service.diagnose(); expect(!result.ok && result.error.code).toBe("STORE_UNAVAILABLE"); });
it("serializes across processes and releases the SQLite lock after process death", async () => {
  const root = tempRoot(); cleanup = root.cleanup; const service = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids: new TestIds(), lockTimeoutMs: 20 }); service.initialize(); const lockPath = new RepositoryLayout(root.path).lockDatabase;
  const script = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.env.LOCK); db.exec('PRAGMA busy_timeout=100; BEGIN IMMEDIATE'); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--eval", script], { env: { ...process.env, LOCK: lockPath }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); });
  const locked = service.diagnose(); expect(!locked.ok && locked.error.code).toBe("STORE_LOCKED"); child.kill(process.platform === "win32" ? undefined : "SIGKILL"); await once(child, "exit");
  expect(service.diagnose().ok).toBe(true);
});
