import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { assertFilePathBeforeOpen, assertOpenedFileIdentity } from "../repository/path-safety.js";
export const INDEX_FORMAT_VERSION = "common-memory-index-v1;normalize=NFKC+lower+ws;tokenizer=trigram;columns=statement,tags,scope_id";
export function openIndex(path: string, readOnly = false): DatabaseSync { const root = dirname(dirname(path)); assertFilePathBeforeOpen(root, path); const db = new DatabaseSync(path, { readOnly }); try { assertOpenedFileIdentity(root, path); return db; } catch (error) { db.close(); throw error; } }
export function createIndexSchema(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID; CREATE TABLE facts (rowid INTEGER PRIMARY KEY, fact_id TEXT NOT NULL UNIQUE); CREATE VIRTUAL TABLE facts_fts USING fts5(statement, tags, scope_id, tokenize='trigram');");
}
