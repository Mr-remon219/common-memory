import type { SearchResult } from "../contracts/dto.js";
import type { Fact } from "../contracts/types.js";
import { canonicalScope } from "../query/scope.js";
import { normalizeSearchText } from "./normalize.js";

export const RANKING_V1 = Object.freeze({ candidateLimit: 100, exactTag: 0.2, exactScope: 0.1, priority: { core: 0.15, normal: 0.05, archive: 0 }, temporal: 0.05, provenance: { user_correction: 0.06, user_statement: 0.05, project_evidence: 0.03, imported_event: 0.02, agent_observation: 0.01 } });
export interface Candidate { fact: Fact; raw_bm25: number | null; fallback: "fts5" | "short-query"; matched_fields: string[] }
export function rankCandidates(candidates: Candidate[], _query: string, requestedTags: readonly string[], scopes: ReadonlySet<string>, validAt: string): SearchResult[] {
  const raw = candidates.map((candidate) => candidate.raw_bm25).filter((value): value is number => value !== null); const best = raw.length ? Math.min(...raw) : 0; const worst = raw.length ? Math.max(...raw) : 0; const exactTags = new Set(requestedTags.map(normalizeSearchText));
  return candidates.map((candidate) => {
    const fact = candidate.fact; const lexical = candidate.raw_bm25 === null || best === worst ? 1 : (worst - candidate.raw_bm25) / (worst - best);
    const matchedFields = candidate.matched_fields;
    const boosts = { exact_tag: fact.tags.some((tag) => exactTags.has(normalizeSearchText(tag))) ? RANKING_V1.exactTag : 0, exact_scope: scopes.has(canonicalScope(fact.scope)) ? RANKING_V1.exactScope : 0, priority: RANKING_V1.priority[fact.priority], temporal: fact.kind === "event" && Date.parse(fact.validity.valid_from) <= Date.parse(validAt) ? RANKING_V1.temporal : 0, provenance: RANKING_V1.provenance[fact.provenance.type] };
    const finalScore = lexical + Object.values(boosts).reduce((sum, value) => sum + value, 0); const reasons = [candidate.fallback, ...matchedFields.map((field) => `matched:${field}`), ...Object.entries(boosts).filter(([, value]) => value > 0).map(([key]) => `boost:${key}`)];
    return { fact, raw_bm25: candidate.raw_bm25, lexical_rank: lexical, boosts, final_score: finalScore, matched_fields: matchedFields, fallback: candidate.fallback, match_reasons: reasons };
  }).sort((a, b) => b.final_score - a.final_score || b.lexical_rank - a.lexical_rank || a.fact.id.localeCompare(b.fact.id, "en"));
}
