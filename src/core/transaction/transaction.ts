import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CoreError } from "../contracts/errors.js";
import type { FaultInjector, IdGenerator } from "../contracts/ports.js";
import type { Revision } from "../contracts/types.js";
import type { RepositoryLayout } from "../repository/layout.js";
import { assertRealDirectory, authorityRelativePath, resolveAuthorityTarget } from "../repository/path-safety.js";
import { atomicReplace } from "./atomic-file.js";
import { fsyncFile, persistDirectory, publishFileAtomically } from "./fsync.js";
import { validateJournal, type JournalRecord, type JournalTarget } from "./journal.js";
import { MAX_AUTHORITY_FILE_BYTES, readBoundedRegular } from "../repository/bounded-read.js";

export interface Mutation { path: string; bytes: Uint8Array }
const TRANSACTION_ID = /^transaction\.[A-Za-z0-9_-]{8,128}$/;
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
export function applyTransaction(layout: RepositoryLayout, mutations: readonly Mutation[], expectedPost: { knowledge: Revision; store: Revision }, ids: IdGenerator, faults: FaultInjector, verify: () => void): void {
  const transactionId = ids.next("transaction"); if (!TRANSACTION_ID.test(transactionId) || mutations.length === 0) throw new CoreError("STORE_UNAVAILABLE", "Invalid transaction identity or empty mutation set");
  assertRealDirectory(layout.transactions, layout.state); const directory = join(layout.transactions, transactionId); mkdirSync(directory, { recursive: false, mode: 0o700 }); persistDirectory(layout.transactions);
  const targets: JournalTarget[] = []; const seen = new Set<string>();
  try {
    mutations.forEach((mutation, index) => {
      const relativePath = authorityRelativePath(layout, mutation.path); if (seen.has(relativePath)) throw new CoreError("STORE_UNAVAILABLE", "Duplicate transaction target", { rule_id: "transaction.duplicate_target" }); seen.add(relativePath);
      if (mutation.bytes.byteLength > MAX_AUTHORITY_FILE_BYTES) throw new CoreError("STORE_UNAVAILABLE", "Authority mutation exceeds file limit"); const verifiedPath = resolveAuthorityTarget(layout, relativePath); const beforeBytes = existsSync(verifiedPath) ? readBoundedRegular(verifiedPath, MAX_AUTHORITY_FILE_BYTES) : null;
      const stagingName = `staging-${index}`; const stagingPath = join(directory, stagingName);
      const fd = openSync(stagingPath, "wx", 0o600); try { writeFileSync(fd, mutation.bytes); faults.checkpoint("journal-write", relativePath); fsyncSync(fd); faults.checkpoint("journal-fsync", relativePath); } finally { closeSync(fd); }
      targets.push({ relative_path: relativePath, staging_name: stagingName, temp_name: `.${transactionId}.${index}.tmp`, before: beforeBytes ? { exists: true, sha256: digest(beforeBytes), length: beforeBytes.length } : { exists: false, sha256: "", length: 0 }, after: { sha256: digest(mutation.bytes), length: mutation.bytes.length } });
    });
    const journal: JournalRecord = validateJournal({ version: 1, transaction_id: transactionId, phase: "PREPARED", expected_knowledge_revision: expectedPost.knowledge, expected_store_revision: expectedPost.store, targets }, transactionId);
    const journalTemp = join(directory, "journal.tmp"); writeFileSync(journalTemp, `${JSON.stringify(journal)}\n`, { mode: 0o600 }); fsyncFile(journalTemp); publishFileAtomically(journalTemp, join(directory, "journal.json")); persistDirectory(layout.transactions);
    const markerTemp = join(directory, "COMMITTING.tmp"); writeFileSync(markerTemp, "v1\n", { mode: 0o600 }); fsyncFile(markerTemp); publishFileAtomically(markerTemp, join(directory, "COMMITTING")); faults.checkpoint("commit-marker", transactionId);
    mutations.forEach((mutation, index) => { const target = targets[index]!; const path = resolveAuthorityTarget(layout, target.relative_path); atomicReplace(layout, path, mutation.bytes, join(dirname(path), target.temp_name), faults); });
    faults.checkpoint("post-check", transactionId); verify();
    const tombstone = join(layout.transactions, `done.${transactionId}`); renameSync(directory, tombstone); persistDirectory(layout.transactions); faults.checkpoint("cleanup-publish", transactionId);
    rmSync(tombstone, { recursive: true, force: true }); persistDirectory(layout.transactions); faults.checkpoint("cleanup", transactionId);
  } catch (error) { throw error; }
}
