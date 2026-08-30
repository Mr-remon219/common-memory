const SET_KEYS = new Set(["tags", "supersedes", "target_fact_ids", "resulting_fact_ids", "reverts_review_ids"]);
const TIME_KEYS = new Set(["initialized_at", "observed_at", "received_at", "created_at", "reviewed_at", "confirmed_at", "valid_from", "expires_at"]);

export function normalizeSemantic<T>(input: T): T {
  function visit(value: unknown, key = ""): unknown {
    if (Array.isArray(value)) {
      const normalized = value.map((item) => visit(item));
      return SET_KEYS.has(key) ? normalized.sort((a, b) => compareUtf8(String(a), String(b))) : normalized;
    }
    if (value && typeof value === "object") {
      const output: Record<string, unknown> = {};
      for (const childKey of Object.keys(value as object).sort(compareUtf8)) output[childKey] = visit((value as Record<string, unknown>)[childKey], childKey);
      return output;
    }
    if (typeof value === "string" && TIME_KEYS.has(key)) return new Date(value).toISOString();
    return value;
  }
  return visit(input) as T;
}
function compareUtf8(a: string, b: string): number { return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")); }
