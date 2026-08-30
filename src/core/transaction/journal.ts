import { CoreError } from "../contracts/errors.js";
import { MAX_AUTHORITY_FILE_BYTES } from "../repository/bounded-read.js";

export interface JournalTarget { relative_path: string; staging_name: string; temp_name: string; before: { exists: boolean; sha256: string; length: number }; after: { sha256: string; length: number } }
export interface JournalRecord { version: 1; transaction_id: string; phase: "PREPARED"; expected_knowledge_revision: string; expected_store_revision: string; targets: JournalTarget[] }

const TRANSACTION_ID = /^transaction\.[A-Za-z0-9_-]{8,128}$/;
const REVISION = /^sha256:[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const AUTHORITY_TARGET = /^memory\/(facts\/fact\.[A-Za-z0-9_-]{8,128}|proposals\/proposal\.[A-Za-z0-9_-]{8,128}|reviews\/review\.[A-Za-z0-9_-]{8,128})\.yaml$/;
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value).sort(); return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function invalid(): never { throw new CoreError("STORE_UNAVAILABLE", "Transaction journal validation failed", { rule_id: "transaction.invalid_journal" }); }
function validateImage(value: unknown, before: boolean): void {
  if (!object(value) || !exactKeys(value, before ? ["exists", "sha256", "length"] : ["sha256", "length"])) invalid();
  if (!Number.isSafeInteger(value.length) || (value.length as number) < 0 || (value.length as number) > MAX_AUTHORITY_FILE_BYTES || typeof value.sha256 !== "string") invalid();
  if (before) {
    if (typeof value.exists !== "boolean") invalid();
    if (value.exists ? !DIGEST.test(value.sha256) : value.sha256 !== "" || value.length !== 0) invalid();
  } else if (!DIGEST.test(value.sha256)) invalid();
}
export function validateJournal(value: unknown, directoryName: string): JournalRecord {
  if (!object(value) || !exactKeys(value, ["version", "transaction_id", "phase", "expected_knowledge_revision", "expected_store_revision", "targets"])) invalid();
  if (value.version !== 1 || value.phase !== "PREPARED" || typeof value.transaction_id !== "string" || !TRANSACTION_ID.test(value.transaction_id) || value.transaction_id !== directoryName || typeof value.expected_knowledge_revision !== "string" || !REVISION.test(value.expected_knowledge_revision) || typeof value.expected_store_revision !== "string" || !REVISION.test(value.expected_store_revision) || !Array.isArray(value.targets) || value.targets.length === 0) invalid();
  const seen = new Set<string>();
  value.targets.forEach((entry, index) => {
    if (!object(entry) || !exactKeys(entry, ["relative_path", "staging_name", "temp_name", "before", "after"]) || typeof entry.relative_path !== "string" || !AUTHORITY_TARGET.test(entry.relative_path) || seen.has(entry.relative_path) || entry.staging_name !== `staging-${index}` || entry.temp_name !== `.${value.transaction_id}.${index}.tmp`) invalid();
    seen.add(entry.relative_path); validateImage(entry.before, true); validateImage(entry.after, false);
  });
  return value as unknown as JournalRecord;
}
