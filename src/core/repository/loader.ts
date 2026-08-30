import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CoreError } from "../contracts/errors.js";
import { SCHEMA_FILES, schemaBundleDigest, schemaBytes } from "../contracts/schema-registry.js";
import type { Fact, Proposal, RepositoryMetadata, Review, Revision } from "../contracts/types.js";
import { parseYamlStrict } from "../serialization/parse.js";
import { knowledgeRevision, storeRevision } from "../revision/revisions.js";
import { validateIntegrity } from "./integrity.js";
import { immutableSnapshot } from "./snapshot.js";
import type { RepositoryLayout } from "./layout.js";
import { scanFact, scanProposal, scanReview } from "../safety/scanner.js";
import { assertRealDirectory, assertRepositoryDirectoryTree } from "./path-safety.js";
import { MAX_AUTHORITY_FILE_BYTES, readBoundedRegular } from "./bounded-read.js";
import { openIndex } from "../index/database.js";

function safeFile(path: string, root: string): Buffer {
  assertRealDirectory(dirname(path), root); return readBoundedRegular(path, MAX_AUTHORITY_FILE_BYTES);
}
function readRecords<T>(directory: string, repositoryRoot: string, prefix: string, kind: "fact" | "proposal" | "review", scan: (record: T) => void): Map<string, T> {
  assertRealDirectory(directory, repositoryRoot);
  const result = new Map<string, T>();
  for (const name of readdirSync(directory).sort()) {
    if (!new RegExp(`^${prefix}\\.[A-Za-z0-9_-]{8,128}\\.yaml$`).test(name)) unavailable("repository.unknown_authority_file");
    const record = parseYamlStrict(safeFile(join(directory, name), repositoryRoot), kind) as T & { id: string };
    if (`${record.id}.yaml` !== name || result.has(record.id)) unavailable("repository.id_filename_mismatch");
    scan(record); result.set(record.id, record);
  }
  return result;
}
function ensureTree(layout: RepositoryLayout): void {
  assertRepositoryDirectoryTree(layout);
  const allowedRoot = new Set([".git", "memory", "repository.yaml", "schema"]);
  for (const name of readdirSync(layout.repositoryRoot)) if (!allowedRoot.has(name)) unavailable("repository.unknown_authority_file");
  const memory = join(layout.repositoryRoot, "memory");
  for (const name of readdirSync(memory)) if (!new Set(["facts", "proposals", "reviews"]).has(name)) unavailable("repository.unknown_authority_file");
  for (const dir of [layout.schema, layout.facts, layout.proposals, layout.reviews]) for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) unavailable("repository.non_regular_file");
}
function indexRevision(path: string): Revision | null {
  if (!existsSync(dirname(path))) return null;
  let db: DatabaseSync | undefined;
  try { db = openIndex(path, true); const row = db.prepare("SELECT value FROM metadata WHERE key='index_revision'").get() as { value?: string } | undefined; db.close(); db = undefined; return typeof row?.value === "string" && /^sha256:[0-9a-f]{64}$/.test(row.value) ? row.value as Revision : null; } catch (error) { try { db?.close(); } catch { /* An unreadable derived index is represented by null. */ } if (error instanceof CoreError && error.code === "STORE_UNAVAILABLE") throw error; return null; }
}
export function loadRepository(layout: RepositoryLayout) {
  try {
    ensureTree(layout);
    const repository = parseYamlStrict(safeFile(join(layout.repositoryRoot, "repository.yaml"), layout.repositoryRoot), "repository") as RepositoryMetadata;
    if (repository.schema_bundle_digest !== schemaBundleDigest) unavailable("repository.schema_digest_mismatch");
    const schemaNames = readdirSync(layout.schema).sort(); if (schemaNames.length !== SCHEMA_FILES.length || schemaNames.some((name, index) => name !== [...SCHEMA_FILES].sort()[index])) unavailable("repository.schema_bundle_files");
    for (const name of SCHEMA_FILES) if (!safeFile(join(layout.schema, name), layout.repositoryRoot).equals(schemaBytes(name))) unavailable("repository.schema_bundle_mismatch");
    const facts = readRecords<Fact>(layout.facts, layout.repositoryRoot, "fact", "fact", scanFact);
    const proposals = readRecords<Proposal>(layout.proposals, layout.repositoryRoot, "proposal", "proposal", scanProposal);
    const reviews = readRecords<Review>(layout.reviews, layout.repositoryRoot, "review", "review", scanReview);
    validateIntegrity(repository, facts, proposals, reviews);
    return immutableSnapshot(repository, facts, proposals, reviews, knowledgeRevision(facts.values()), storeRevision({ repository, facts: facts.values(), proposals: proposals.values(), reviews: reviews.values() }), indexRevision(layout.indexDatabase));
  } catch (error) {
    if (error instanceof CoreError && error.code === "STORE_UNAVAILABLE") throw error;
    throw new CoreError("STORE_UNAVAILABLE", "The memory repository is unavailable", { rule_id: "repository.load_failed" }, { cause: error });
  }
}
function unavailable(rule_id: string): never { throw new CoreError("STORE_UNAVAILABLE", "Repository validation failed", { violations: [{ rule_id }] }); }
