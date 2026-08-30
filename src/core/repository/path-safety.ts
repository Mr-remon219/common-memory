import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { CoreError } from "../contracts/errors.js";
import type { RepositoryLayout } from "./layout.js";

const AUTHORITY_TARGET = /^memory\/(facts\/fact\.[A-Za-z0-9_-]{8,128}|proposals\/proposal\.[A-Za-z0-9_-]{8,128}|reviews\/review\.[A-Za-z0-9_-]{8,128})\.yaml$/;

function unavailable(rule_id: string): never {
  throw new CoreError("STORE_UNAVAILABLE", "Repository path validation failed", { violations: [{ rule_id }] });
}

export function assertRealDirectory(path: string, expectedRoot?: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) unavailable("repository.symlink_or_non_directory");
  const real = realpathSync(path);
  if (expectedRoot !== undefined) {
    const root = realpathSync(expectedRoot);
    if (real !== root && !real.startsWith(`${root}${sep}`)) unavailable("repository.path_escape");
  }
}

export function ensureContainedDirectory(root: string, path: string): void {
  assertRealDirectory(root);
  if (!existsSync(path)) mkdirSync(path, { recursive: false });
  assertRealDirectory(path, root);
}

export function assertFilePathBeforeOpen(root: string, path: string): void {
  assertRealDirectory(root); assertRealDirectory(dirname(path), root);
  if (existsSync(path)) { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) unavailable("repository.symlink_or_non_file"); }
}

export function assertOpenedFileIdentity(root: string, path: string): void {
  assertFilePathBeforeOpen(root, path); const before = lstatSync(path); const fd = openSync(path, "r");
  try { const opened = fstatSync(fd); if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) unavailable("repository.file_identity_changed"); }
  finally { closeSync(fd); }
}

export function assertRepositoryDirectoryTree(layout: RepositoryLayout): void {
  assertRealDirectory(layout.dataRoot);
  assertRealDirectory(layout.repositoryRoot, layout.dataRoot);
  const memory = resolve(layout.repositoryRoot, "memory");
  assertRealDirectory(memory, layout.repositoryRoot);
  assertRealDirectory(layout.schema, layout.repositoryRoot);
  assertRealDirectory(layout.facts, layout.repositoryRoot);
  assertRealDirectory(layout.proposals, layout.repositoryRoot);
  assertRealDirectory(layout.reviews, layout.repositoryRoot);
}

export function authorityRelativePath(layout: RepositoryLayout, absolutePath: string): string {
  const root = resolve(layout.repositoryRoot); const path = resolve(absolutePath);
  const relativePath = relative(root, path).replaceAll("\\", "/");
  if (!AUTHORITY_TARGET.test(relativePath)) unavailable("transaction.invalid_authority_target");
  return relativePath;
}

export function resolveAuthorityTarget(layout: RepositoryLayout, relativePath: string): string {
  if (!AUTHORITY_TARGET.test(relativePath)) unavailable("transaction.invalid_authority_target");
  assertRepositoryDirectoryTree(layout);
  const path = resolve(layout.repositoryRoot, ...relativePath.split("/"));
  authorityRelativePath(layout, path);
  const parent = dirname(path); assertRealDirectory(parent, layout.repositoryRoot);
  return path;
}

export function assertTransactionDirectory(layout: RepositoryLayout, directory: string): void {
  assertRealDirectory(layout.dataRoot);
  assertRealDirectory(layout.state, layout.dataRoot);
  assertRealDirectory(layout.transactions, layout.state);
  assertRealDirectory(directory, layout.transactions);
}
