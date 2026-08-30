import { DatabaseSync } from "node:sqlite";
import { CoreError } from "../contracts/errors.js";
export interface IndexCapability { sqlite_version: string; fts5: true; trigram: true }
export function probeIndexCapability(): IndexCapability {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(":memory:"); const version = (db.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version;
    const options = db.prepare("PRAGMA compile_options").all() as Array<{ compile_options: string }>;
    if (!options.some((row) => row.compile_options === "ENABLE_FTS5")) throw new Error("FTS5 unavailable");
    db.exec("CREATE VIRTUAL TABLE probe USING fts5(statement, tags, scope_id, tokenize='trigram'); DROP TABLE probe;"); db.close(); db = undefined;
    return { sqlite_version: version, fts5: true, trigram: true };
  } catch (error) { try { db?.close(); } catch { /* Preserve the stable capability error. */ } throw new CoreError("INDEX_OUTDATED", "The required SQLite FTS5 trigram capability is unavailable", { rule_id: "index.capability_unavailable" }, { cause: error }); }
}
