import { expect, it } from "vitest";
import { parseScopes, scopeMatches } from "../../src/core/query/scope.js";
import { isCurrentlyValid } from "../../src/core/query/validity.js";
import { parseQueryTime } from "../../src/core/query/time.js";
import type { Fact } from "../../src/core/contracts/types.js";
const fact = { status: "confirmed", validity: { valid_from: "2026-01-01T00:00:00.000Z", expires_at: "2026-01-02T00:00:00.000Z" } } as Fact;
it("uses exact scopes without implicit global", () => { const scopes = parseScopes(["project:a"]); expect(scopeMatches({ type: "project", id: "a" }, scopes)).toBe(true); expect(scopeMatches({ type: "global", id: null }, scopes)).toBe(false); expect(() => parseScopes([])).toThrow(); });
it("uses half-open validity boundaries", () => { expect(isCurrentlyValid(fact, "2026-01-01T00:00:00.000Z")).toBe(true); expect(isCurrentlyValid(fact, "2026-01-02T00:00:00.000Z")).toBe(false); });
it("rejects calendar dates that Date.parse would normalize", () => {
  expect(() => parseQueryTime("2026-02-31T00:00:00Z", "valid_at")).toThrow();
  expect(() => parseQueryTime("2025-02-29T00:00:00Z", "valid_at")).toThrow();
  expect(parseQueryTime("2024-02-29T23:59:59+08:00", "valid_at")).toBe("2024-02-29T15:59:59.000Z");
});
