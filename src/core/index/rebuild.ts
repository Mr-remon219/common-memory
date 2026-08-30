import { existsSync, rmSync } from "node:fs";
import type { RepositorySnapshot } from "../contracts/types.js";
import type { RepositoryLayout } from "../repository/layout.js";
import { CoreError } from "../contracts/errors.js";
import { canonicalScope } from "../query/scope.js";
import { normalizeSearchText } from "../search/normalize.js";
import { fsyncFile, publishFileAtomically } from "../transaction/fsync.js";
import { probeIndexCapability } from "./capability.js";
import { createIndexSchema, INDEX_FORMAT_VERSION, openIndex } from "./database.js";
import { assertFilePathBeforeOpen, assertOpenedFileIdentity, ensureContainedDirectory } from "../repository/path-safety.js";
import type { FaultInjector } from "../contracts/ports.js";
import { noFaults } from "../contracts/ports.js";

export function rebuildIndex(layout: RepositoryLayout, snapshot: RepositorySnapshot, faults: FaultInjector = noFaults): void {
  probeIndexCapability(); ensureContainedDirectory(layout.dataRoot, layout.index); assertFilePathBeforeOpen(layout.dataRoot, layout.indexDatabase); const temp = `${layout.indexDatabase}.${process.pid}.tmp`; assertFilePathBeforeOpen(layout.dataRoot, temp); rmSync(temp, { force: true }); faults.checkpoint("index-rebuild", temp); let db: ReturnType<typeof openIndex> | undefined;
  try {
    db = openIndex(temp); assertOpenedFileIdentity(layout.dataRoot, temp); createIndexSchema(db); const insertFact = db.prepare("INSERT INTO facts(rowid, fact_id) VALUES(?, ?)"); const insertFts = db.prepare("INSERT INTO facts_fts(rowid, statement, tags, scope_id) VALUES(?, ?, ?, ?)"); let rowid = 1;
    db.exec("BEGIN IMMEDIATE"); for (const fact of [...snapshot.facts.values()].sort((a, b) => a.id.localeCompare(b.id, "en"))) { insertFact.run(rowid, fact.id); insertFts.run(rowid, normalizeSearchText(fact.statement), normalizeSearchText(fact.tags.join(" ")), normalizeSearchText(canonicalScope(fact.scope))); rowid++; }
    db.prepare("INSERT INTO metadata(key, value) VALUES('index_revision', ?), ('index_format_version', ?)").run(snapshot.knowledge_revision, INDEX_FORMAT_VERSION); db.exec("COMMIT");
    const check = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }; if (check.integrity_check !== "ok") throw new Error("integrity check failed"); db.close(); db = undefined; fsyncFile(temp); faults.checkpoint("index-publish", layout.indexDatabase); publishFileAtomically(temp, layout.indexDatabase); assertOpenedFileIdentity(layout.dataRoot, layout.indexDatabase);
  } catch (error) { try { db?.close(); } catch { /* Preserve the stable rebuild error. */ } rmSync(temp, { force: true }); throw new CoreError("INDEX_OUTDATED", "The derived search index could not be rebuilt", { rule_id: "index.rebuild_failed" }, { cause: error }); }
  if (!existsSync(layout.indexDatabase)) throw new CoreError("INDEX_OUTDATED", "The derived search index could not be published");
}
