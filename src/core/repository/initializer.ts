import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CoreError } from "../contracts/errors.js";
import { SCHEMA_FILES, schemaBundleDigest, schemaBytes } from "../contracts/schema-registry.js";
import type { Clock, IdGenerator } from "../contracts/ports.js";
import type { RepositoryMetadata } from "../contracts/types.js";
import { canonicalYamlBytes } from "../serialization/canonical-yaml.js";
import { fsyncDirectory, fsyncFile } from "../transaction/fsync.js";
import type { FaultInjector } from "../contracts/ports.js";
import type { RepositorySnapshot } from "../contracts/types.js";
import type { RepositoryLayout } from "./layout.js";
import { RepositoryLock } from "../transaction/lock.js";
import { recoverAll } from "../transaction/recovery.js";
import { loadRepository } from "./loader.js";
import { assertRealDirectory, ensureContainedDirectory } from "./path-safety.js";

function syncTree(root: string): void {
  function visit(path: string): void {
    const stat = lstatSync(path);
    if (stat.isFile()) { fsyncFile(path); return; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CoreError("STORE_UNAVAILABLE", "Bootstrap produced an unsupported filesystem entry");
    for (const name of readdirSync(path)) visit(join(path, name));
    fsyncDirectory(path);
  }
  visit(root);
}
export function bootstrapRepository(layout: RepositoryLayout, clock: Clock, ids: IdGenerator, faults: FaultInjector, lockTimeoutMs: number): RepositorySnapshot {
  if (!existsSync(layout.dataRoot)) mkdirSync(layout.dataRoot, { recursive: true }); assertRealDirectory(layout.dataRoot); ensureContainedDirectory(layout.dataRoot, layout.state); ensureContainedDirectory(layout.state, layout.transactions);
  const lock = new RepositoryLock(layout.lockDatabase, lockTimeoutMs, faults);
  try {
    if (existsSync(layout.repositoryRoot)) { recoverAll(layout, faults); return loadRepository(layout); }
    initializeRepository(layout, clock, ids); return loadRepository(layout);
  } finally { try { lock.close(); } catch { /* A completed bootstrap response is not replaced by cleanup failure. */ } }
}

export function initializeRepository(layout: RepositoryLayout, clock: Clock, ids: IdGenerator): void {
  if (existsSync(layout.repositoryRoot)) throw new CoreError("CONFLICT_DETECTED", "A repository already exists", { reason: "REPOSITORY_EXISTS" });
  mkdirSync(layout.dataRoot, { recursive: true });
  const temp = join(layout.dataRoot, `.repository-${ids.next("transaction")}.tmp`);
  try {
    mkdirSync(join(temp, "memory", "facts"), { recursive: true }); mkdirSync(join(temp, "memory", "proposals")); mkdirSync(join(temp, "memory", "reviews")); mkdirSync(join(temp, "schema"));
    const metadata: RepositoryMetadata = { schema_version: 1, repository_id: ids.next("repository"), initialized_at: clock.now().toISOString(), schema_bundle_digest: schemaBundleDigest };
    writeFileSync(join(temp, "repository.yaml"), canonicalYamlBytes("repository", metadata), { mode: 0o600 });
    for (const name of SCHEMA_FILES) writeFileSync(join(temp, "schema", name), schemaBytes(name), { mode: 0o600 });
    execFileSync("git", ["-c", "init.templateDir=", "init", "--quiet", temp], { stdio: "ignore" });
    syncTree(temp); renameSync(temp, layout.repositoryRoot); fsyncDirectory(dirname(layout.repositoryRoot));
  } catch (error) { rmSync(temp, { recursive: true, force: true }); if (error instanceof CoreError) throw error; throw new CoreError("STORE_UNAVAILABLE", "Repository initialization failed", {}, { cause: error }); }
}
