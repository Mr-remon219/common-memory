import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { CoreError } from "../contracts/errors.js";
import type { FaultInjector } from "../contracts/ports.js";
import type { RepositoryLayout } from "../repository/layout.js";
import { assertTransactionDirectory, resolveAuthorityTarget } from "../repository/path-safety.js";
import { loadRepository } from "../repository/loader.js";
import { atomicReplace } from "./atomic-file.js";
import { persistDirectory } from "./fsync.js";
import { validateJournal, type JournalTarget } from "./journal.js";
import { MAX_AUTHORITY_FILE_BYTES, MAX_JOURNAL_BYTES, MAX_MARKER_BYTES, readBoundedRegular } from "../repository/bounded-read.js";

const TRANSACTION_ID = /^transaction\.[A-Za-z0-9_-]{8,128}$/;
const TOMBSTONE_ID = /^done\.transaction\.[A-Za-z0-9_-]{8,128}$/;
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function state(path: string): { exists: boolean; sha256: string; length: number } { if (!existsSync(path)) return { exists: false, sha256: "", length: 0 }; const bytes = readBoundedRegular(path, MAX_AUTHORITY_FILE_BYTES); return { exists: true, sha256: digest(bytes), length: bytes.length }; }
function same(a: ReturnType<typeof state>, b: JournalTarget["before"] | JournalTarget["after"]): boolean { return a.exists === ("exists" in b ? b.exists : true) && a.sha256 === b.sha256 && a.length === b.length; }
export function recoverAll(layout: RepositoryLayout, faults: FaultInjector): void {
  if (!existsSync(layout.transactions)) return;
  for (const name of readdirSync(layout.transactions).sort()) {
    const directory = join(layout.transactions, name);
    if (TOMBSTONE_ID.test(name)) { assertTransactionDirectory(layout, directory); rmSync(directory, { recursive: true, force: true }); persistDirectory(layout.transactions); continue; }
    if (!TRANSACTION_ID.test(name)) unavailable();
    try {
      assertTransactionDirectory(layout, directory);
      const journalPath = join(directory, "journal.json"); const markerPath = join(directory, "COMMITTING");
      if (!existsSync(journalPath)) {
        if (existsSync(markerPath)) unavailable();
        rmSync(directory, { recursive: true, force: true }); persistDirectory(layout.transactions); continue;
      }
      const journal = validateJournal(JSON.parse(readBoundedRegular(journalPath, MAX_JOURNAL_BYTES).toString("utf8")) as unknown, name);
      const committing = existsSync(markerPath);
      if (committing && readBoundedRegular(markerPath, MAX_MARKER_BYTES).toString("utf8") !== "v1\n") unavailable();
      for (const target of journal.targets) {
        const path = resolveAuthorityTarget(layout, target.relative_path); const current = state(path);
        const staging = join(directory, target.staging_name); const staged = state(staging);
        if (!staged.exists || staged.sha256 !== target.after.sha256 || staged.length !== target.after.length) unavailable();
        if (!committing) { if (!same(current, target.before)) unavailable(); }
        else if (!same(current, { exists: true, ...target.after })) {
          if (!same(current, target.before)) unavailable();
          resolveAuthorityTarget(layout, target.relative_path);
          atomicReplace(layout, path, readBoundedRegular(staging, MAX_AUTHORITY_FILE_BYTES), join(dirname(path), target.temp_name), faults);
        }
      }
      if (committing) {
        const snapshot = loadRepository(layout);
        if (snapshot.knowledge_revision !== journal.expected_knowledge_revision || snapshot.store_revision !== journal.expected_store_revision) unavailable();
      }
      assertTransactionDirectory(layout, directory); rmSync(directory, { recursive: true, force: true }); persistDirectory(layout.transactions);
    } catch (error) { if (error instanceof CoreError) throw error; throw new CoreError("STORE_UNAVAILABLE", "Transaction recovery failed", { rule_id: "transaction.unprovable" }, { cause: error }); }
  }
}
function unavailable(): never { throw new CoreError("STORE_UNAVAILABLE", "Transaction recovery cannot prove repository state", { rule_id: "transaction.unprovable" }); }
