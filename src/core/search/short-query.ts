import type { Fact } from "../contracts/types.js";
import { canonicalScope } from "../query/scope.js";
import { normalizeSearchText } from "./normalize.js";
import type { Candidate } from "./rank.js";
export function shortQueryCandidates(facts: readonly Fact[], query: string): Candidate[] {
  const needle = normalizeSearchText(query); return facts.flatMap((fact) => { const fields: string[] = []; if (normalizeSearchText(fact.statement).includes(needle)) fields.push("statement"); if (fact.tags.some((tag) => normalizeSearchText(tag).includes(needle))) fields.push("tags"); if (normalizeSearchText(canonicalScope(fact.scope)).includes(needle)) fields.push("scope_id"); return fields.length ? [{ fact, raw_bm25: null, fallback: "short-query" as const, matched_fields: fields }] : []; });
}
