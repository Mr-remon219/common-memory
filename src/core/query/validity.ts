import type { Fact, TimeRange } from "../contracts/types.js";
export function isCurrentlyValid(fact: Fact, validAt: string): boolean {
  const at = Date.parse(validAt); return fact.status === "confirmed" && Date.parse(fact.validity.valid_from) <= at && (fact.validity.expires_at === null || at < Date.parse(fact.validity.expires_at));
}
export function intersectsTimeRange(fact: Fact, range: TimeRange | null | undefined): boolean {
  if (!range) return true;
  const factFrom = Date.parse(fact.validity.valid_from); const factTo = fact.validity.expires_at === null ? Number.POSITIVE_INFINITY : Date.parse(fact.validity.expires_at);
  const from = range.from === null ? Number.NEGATIVE_INFINITY : Date.parse(range.from); const to = range.to === null ? Number.POSITIVE_INFINITY : Date.parse(range.to);
  return factFrom < to && from < factTo;
}
