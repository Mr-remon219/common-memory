import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { CoreError } from "../contracts/errors.js";
export const MAX_AUTHORITY_FILE_BYTES = 1_048_576;
export const MAX_JOURNAL_BYTES = 1_048_576;
export const MAX_MARKER_BYTES = 16;
function unavailable(rule_id: string): never { throw new CoreError("STORE_UNAVAILABLE", "Bounded file read failed", { rule_id }); }
export function readBoundedRegular(path: string, maxBytes: number): Buffer {
  const before = lstatSync(path); if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) unavailable("repository.invalid_or_oversize_file");
  const fd = openSync(path, "r");
  try {
    const opened = fstatSync(fd); if (!opened.isFile() || opened.size > maxBytes || opened.dev !== before.dev || opened.ino !== before.ino) unavailable("repository.file_identity_changed");
    const bytes = Buffer.alloc(opened.size); let offset = 0; while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (count === 0) unavailable("repository.short_read"); offset += count; }
    const after = fstatSync(fd); if (after.size !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino) unavailable("repository.file_identity_changed"); return bytes;
  } finally { closeSync(fd); }
}
