import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateMemoryAnalysis } from "../../src/memory-manager/analysis-validator.js";
import type { AnalysisRequestContext } from "../../src/memory-manager/contracts/analysis.js";

const context: AnalysisRequestContext = {
  requestId: "req_12345678",
  mode: "extract",
  knowledgeRevision: `sha256:${"1".repeat(64)}`,
  storeRevision: `sha256:${"2".repeat(64)}`,
  evidenceRefs: new Set(["ev_1"]),
  candidateFactIds: new Set(),
  allowedScopes: new Set(["global"]),
  maxWriteActions: 3
};
const valid = {
  contract_version: "memory_analysis_v1",
  request_id: context.requestId,
  based_on_knowledge_revision: context.knowledgeRevision,
  based_on_store_revision: context.storeRevision,
  actions: [{ action: "add", confidence: "high", statement: "用户默认使用中文", kind: "preference", scope: "global", priority: "normal", target_fact_ids: [], evidence_refs: ["ev_1"], tags: ["communication"], expires_at: null, reason: "用户明确陈述" }],
  abstained_reason_codes: []
};

describe("MemoryAnalysis v1", () => {
  it("uses only the frozen Structured Outputs keyword subset", () => {
    const schema = JSON.parse(readFileSync("schema/memory-analysis.v1.schema.json", "utf8"));
    const forbidden = new Set(["uniqueItems", "oneOf", "allOf", "if", "then", "not", "unevaluatedProperties"]);
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) { expect(forbidden.has(key), key).toBe(false); visit(child); }
    };
    visit(schema);
  });
  it("accepts a valid echoed extract package", () => expect(validateMemoryAnalysis(valid, context).actions).toHaveLength(1));
  it("requires exactly one auditable evidence ref for every write action", () => expect(() => validateMemoryAnalysis({ ...valid, actions: [{ ...valid.actions[0], evidence_refs: ["ev_1", "ev_2"] }] }, { ...context, evidenceRefs: new Set(["ev_1", "ev_2"]) })).toThrow());
  it("fails the whole package on echo mismatch or duplicate evidence", () => {
    expect(() => validateMemoryAnalysis({ ...valid, request_id: "req_other" }, context)).toThrow();
    expect(() => validateMemoryAnalysis({ ...valid, actions: [{ ...valid.actions[0], evidence_refs: ["ev_1", "ev_1"] }] }, context)).toThrow();
  });
});
