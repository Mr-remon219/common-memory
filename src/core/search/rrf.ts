import type { SearchResult } from "../contracts/dto.js";

export const RECALL_RRF_K = 60;

interface FusedCandidate {
  best: SearchResult;
  bestRank: number;
  score: number;
  queryIndexes: Set<number>;
}

export function reciprocalRankFuse(resultSets: readonly SearchResult[][], limit: number): SearchResult[] {
  const fused = new Map<string, FusedCandidate>();
  for (const [queryIndex, results] of resultSets.entries()) {
    for (const [offset, result] of results.entries()) {
      const rank = offset + 1;
      const current = fused.get(result.fact.id);
      if (!current) {
        fused.set(result.fact.id, { best: result, bestRank: rank, score: 1 / (RECALL_RRF_K + rank), queryIndexes: new Set([queryIndex]) });
        continue;
      }
      current.score += 1 / (RECALL_RRF_K + rank);
      current.queryIndexes.add(queryIndex);
      if (rank < current.bestRank || rank === current.bestRank && result.final_score > current.best.final_score) {
        current.best = result;
        current.bestRank = rank;
      }
    }
  }
  return [...fused.values()]
    .sort((left, right) => right.score - left.score || left.bestRank - right.bestRank || left.best.fact.id.localeCompare(right.best.fact.id, "en"))
    .slice(0, limit)
    .map(({ best, score, queryIndexes }) => ({
      ...best,
      final_score: score,
      match_reasons: [...new Set([...best.match_reasons, `rrf:queries:${[...queryIndexes].join(",")}`])],
    }));
}
