import { basename, dirname, resolve } from "node:path";
import { closeSync, fsyncSync, openSync, rmSync, writeFileSync } from "node:fs";
import { CoreError } from "../contracts/errors.js";
import type { FaultInjector } from "../contracts/ports.js";
import type { RepositoryLayout } from "../repository/layout.js";
import { authorityRelativePath, resolveAuthorityTarget } from "../repository/path-safety.js";
import { publishFileAtomically } from "./fsync.js";

export function atomicReplace(layout: RepositoryLayout, path: string, bytes: Uint8Array, tempPath: string, faults: FaultInjector): void {
  const relativePath = authorityRelativePath(layout, path); const verifiedPath = resolveAuthorityTarget(layout, relativePath); const parent = dirname(verifiedPath);
  if (resolve(dirname(tempPath)) !== resolve(parent) || !/^\.transaction\.[A-Za-z0-9_-]{8,128}\.\d+\.tmp$/.test(basename(tempPath))) throw new CoreError("STORE_UNAVAILABLE", "Invalid atomic replacement path", { rule_id: "transaction.invalid_temp_path" });
  rmSync(tempPath, { force: true });
  const fd = openSync(tempPath, "wx", 0o600);
  try { writeFileSync(fd, bytes); faults.checkpoint("target-write", verifiedPath); fsyncSync(fd); faults.checkpoint("target-fsync", verifiedPath); } finally { closeSync(fd); }
  resolveAuthorityTarget(layout, relativePath);
  publishFileAtomically(tempPath, verifiedPath, () => faults.checkpoint("target-rename", verifiedPath));
  faults.checkpoint("directory-fsync", parent);
}
