import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateRecord } from "../../src/core/contracts/schema-registry.js";
import { CoreError, ERROR_CODES } from "../../src/core/contracts/errors.js";
import type { Proposal } from "../../src/core/contracts/types.js";
import { evidence, suggested } from "../helpers.js";
import { parseYamlStrict } from "../../src/core/serialization/parse.js";

const add: Proposal = { schema_version: 1, id: "proposal.00000001", operation: "add_fact", target_fact_ids: [], suggested_fact: suggested, evidence, reasoning: "用户明确陈述", confidence: "high", source: { client: "local_user", received_at: "2026-01-01T00:00:00.000Z" }, created_at: "2026-01-01T00:00:00.000Z" };
describe("v1 contracts", () => {
  it("freezes the nine stable errors", () => expect(ERROR_CODES).toHaveLength(9));
  it("accepts one discriminated operation", () => { expect(() => validateRecord("proposal", add)).not.toThrow(); expect(() => parseYamlStrict(readFileSync("fixtures/contracts/valid-add-proposal.v1.yaml"), "proposal")).not.toThrow(); });
  it("fails the source-named unknown-field fixture", () => expect(() => parseYamlStrict(readFileSync("fixtures/contracts/invalid-add-proposal-unknown-field.v1.yaml"), "proposal")).toThrow(CoreError));
  it("rejects unknown fields and mixed operations", () => {
    expect(() => validateRecord("proposal", { ...add, unknown: true })).toThrow(CoreError);
    expect(() => validateRecord("proposal", { ...add, suggested_expiration: { expires_at: "2026-01-01T00:00:00.000Z", reason: "x" } })).toThrow(CoreError);
  });
  it("accepts RFC3339 offsets for canonical UTC normalization", () => expect(() => validateRecord("proposal", { ...add, created_at: "2026-01-01T08:00:00+08:00" })).not.toThrow());
});
