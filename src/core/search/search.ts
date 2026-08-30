import { CoreError } from "../contracts/errors.js";
import type { SearchInput, SearchResult } from "../contracts/dto.js";
import type { LockedRepositorySession } from "../repository/locked-session.js";
import { eligibleFacts } from "../query/read.js";
import { canonicalScope, parseScopes } from "../query/scope.js";
import { INDEX_FORMAT_VERSION, openIndex } from "../index/database.js";
import { rebuildIndex } from "../index/rebuild.js";
import { ftsCandidates } from "./fts-query.js";
import { normalizeSearchText, unicodeLength } from "./normalize.js";
import { rankCandidates } from "./rank.js";
import { shortQueryCandidates } from "./short-query.js";

function openValidatedIndex(session: LockedRepositorySession): ReturnType<typeof openIndex> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let db: ReturnType<typeof openIndex> | undefined;
    try {
      db = openIndex(session.layout.indexDatabase, false); db.exec("BEGIN");
      const metadataRows = db.prepare("SELECT key, value FROM metadata WHERE key IN ('index_revision','index_format_version') ORDER BY key").all() as Array<{ key: string; value: string }>; const metadata = new Map(metadataRows.map((row) => [row.key, row.value]));
      if (metadata.get("index_revision") !== session.snapshot.knowledge_revision || metadata.get("index_format_version") !== INDEX_FORMAT_VERSION) throw new Error("stale metadata");
      const counts = db.prepare("SELECT (SELECT count(*) FROM facts) AS facts_count, (SELECT count(*) FROM facts_fts) AS fts_count").get() as { facts_count: number; fts_count: number };
      if (counts.facts_count !== session.snapshot.facts.size || counts.fts_count !== session.snapshot.facts.size) throw new Error("index count mismatch");
      const rows = db.prepare("SELECT f.fact_id, x.statement, x.tags, x.scope_id FROM facts f JOIN facts_fts x ON x.rowid=f.rowid ORDER BY f.fact_id").all() as Array<{ fact_id: string; statement: string; tags: string; scope_id: string }>;
      const expected = [...session.snapshot.facts.values()].sort((a, b) => a.id.localeCompare(b.id, "en"));
      if (rows.length !== expected.length || rows.some((row, index) => { const fact = expected[index]!; return row.fact_id !== fact.id || row.statement !== normalizeSearchText(fact.statement) || row.tags !== normalizeSearchText(fact.tags.join(" ")) || row.scope_id !== normalizeSearchText(canonicalScope(fact.scope)); })) throw new Error("index content mismatch");
      return db;
    } catch (error) {
      try { db?.exec("ROLLBACK"); } catch { /* best effort */ } try { db?.close(); } catch { /* best effort */ }
      if (attempt === 0) { rebuildIndex(session.layout, session.snapshot, session.faults); session.reload(); continue; }
      throw new CoreError("INDEX_OUTDATED", "The search index could not be validated", { rule_id: "index.content_mismatch" }, { cause: error });
    }
  }
  throw new CoreError("INDEX_OUTDATED", "The search index is unavailable");
}
export function searchFacts(session: LockedRepositorySession, input: SearchInput, capturedNow: string): SearchResult[] {
  if (typeof input.query !== "string" || input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== "string" || tag.length === 0))) throw new CoreError("VALIDATION_FAILED", "Invalid search input");
  const query = normalizeSearchText(input.query); if (!query) throw new CoreError("VALIDATION_FAILED", "Search query must not be empty", { violations: [{ field_path: "/query", rule_id: "query.empty" }] });
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) throw new CoreError("VALIDATION_FAILED", "Search limit must be between 1 and 100");
  const scopes = parseScopes(input.scopes);
  const readInput = { scopes: input.scopes, ...(input.kinds !== undefined ? { kinds: input.kinds } : {}), ...(input.include_history !== undefined ? { include_history: input.include_history } : {}), ...(input.valid_at !== undefined ? { valid_at: input.valid_at } : {}), ...(input.time_range !== undefined ? { time_range: input.time_range } : {}) };
  let eligible = eligibleFacts(session.snapshot, readInput, capturedNow);
  if (input.tags?.length) { const tags = new Set(input.tags.map(normalizeSearchText)); eligible = eligible.filter((fact) => fact.tags.some((tag) => tags.has(normalizeSearchText(tag)))); }
  const db = openValidatedIndex(session);
  try {
    const candidates = unicodeLength(query) <= 2 ? shortQueryCandidates(eligible, query) : ftsCandidates(db, eligible, query);
    db.exec("COMMIT"); return rankCandidates(candidates, query, input.tags ?? [], scopes, input.valid_at ?? capturedNow).slice(0, input.limit ?? 10);
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* best effort */ } if (error instanceof CoreError) throw error; throw new CoreError("INDEX_OUTDATED", "The search index query failed", { rule_id: "index.query_failed" }, { cause: error }); }
  finally { db.close(); }
}
