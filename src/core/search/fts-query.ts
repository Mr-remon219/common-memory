import type { DatabaseSync } from "node:sqlite";
import type { Fact } from "../contracts/types.js";
import type { Candidate } from "./rank.js";
import { canonicalScope } from "../query/scope.js";
import { normalizeSearchText } from "./normalize.js";
import { RANKING_V1 } from "./rank.js";

const MAX_QUERY_TERMS = 32;
export interface CompiledSearchTerms { trigrams: string[]; keywords: string[]; expression: string | null }
export function compileSearchTerms(query: string): CompiledSearchTerms {
  const normalized = normalizeSearchText(query); const keywords = [...new Set(normalized.split(/[^\p{L}\p{N}_./\\:-]+/u).filter(Boolean))].slice(0, MAX_QUERY_TERMS);
  const trigrams = new Set<string>();
  for (const keyword of keywords) { const chars = [...keyword]; for (let index = 0; index + 2 < chars.length && trigrams.size < MAX_QUERY_TERMS; index++) trigrams.add(chars.slice(index, index + 3).join("")); }
  const ftsTerms = [...new Set([...trigrams, ...keywords.filter((word) => [...word].length >= 3)])].slice(0, MAX_QUERY_TERMS);
  return { trigrams: [...trigrams], keywords, expression: ftsTerms.length ? ftsTerms.map((term) => `"${term.replaceAll("\"", "\"\"")}"`).join(" OR ") : null };
}
export function matchedFields(fact: Fact, terms: CompiledSearchTerms): string[] {
  const needles = [...new Set([...terms.trigrams, ...terms.keywords])]; const columns = { statement: normalizeSearchText(fact.statement), tags: normalizeSearchText(fact.tags.join(" ")), scope_id: normalizeSearchText(canonicalScope(fact.scope)) };
  return Object.entries(columns).filter(([, value]) => needles.some((needle) => value.includes(needle))).map(([field]) => field);
}
export function keywordCandidates(eligible: readonly Fact[], terms: CompiledSearchTerms): Candidate[] { return eligible.flatMap((fact) => { const fields = matchedFields(fact, terms); return fields.length ? [{ fact, raw_bm25: null, fallback: "short-query" as const, matched_fields: fields }] : []; }); }
export function ftsCandidates(db: DatabaseSync, eligible: readonly Fact[], query: string): Candidate[] {
  const terms = compileSearchTerms(query); if (terms.expression === null) return keywordCandidates(eligible, terms);
  db.exec("DROP TABLE IF EXISTS temp.eligible_ids; CREATE TEMP TABLE eligible_ids(fact_id TEXT PRIMARY KEY) WITHOUT ROWID;"); const insert = db.prepare("INSERT INTO eligible_ids(fact_id) VALUES(?)"); for (const fact of eligible) insert.run(fact.id);
  const rows = db.prepare("SELECT f.fact_id, bm25(facts_fts, 1.0, 1.5, 1.2) AS raw_bm25 FROM facts_fts JOIN facts f ON f.rowid=facts_fts.rowid JOIN eligible_ids e ON e.fact_id=f.fact_id WHERE facts_fts MATCH ? ORDER BY raw_bm25 ASC, f.fact_id ASC LIMIT ?").all(terms.expression, RANKING_V1.candidateLimit) as Array<{ fact_id: string; raw_bm25: number }>;
  const byId = new Map(eligible.map((fact) => [fact.id, fact])); return rows.flatMap((row) => { const fact = byId.get(row.fact_id); if (!fact) return []; const fields = matchedFields(fact, terms); return fields.length ? [{ fact, raw_bm25: row.raw_bm25, fallback: "fts5" as const, matched_fields: fields }] : []; });
}
