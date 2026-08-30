import { closeSync, fsyncSync, openSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { CoreError } from "../contracts/errors.js";

export function fsyncFile(path: string): void {
  const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}

// Node cannot fsync directory handles on Windows (fsyncSync returns EPERM).
// File fsync, atomic rename, and journal recovery still protect transaction integrity.
export function persistDirectory(path: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") return;
  let fd: number | undefined;
  try { fd = openSync(path, "r"); fsyncSync(fd); }
  catch (error) { throw new CoreError("STORE_UNAVAILABLE", "Directory durability is unavailable on this platform", { rule_id: "filesystem.directory_fsync", platform }, { cause: error }); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export const fsyncDirectory = persistDirectory;

export function publishFileAtomically(tempPath: string, targetPath: string, afterRename?: () => void): void {
  // rename is the only publish operation. Replacement failure is surfaced; no
  // remove-then-rename fallback is allowed for an existing target.
  renameSync(tempPath, targetPath); afterRename?.();
  persistDirectory(dirname(targetPath));
}
