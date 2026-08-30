import { expect, it } from "vitest";
import { createProposal } from "../../src/core/governance/proposal.js";
import { CoreError } from "../../src/core/contracts/errors.js";
import { TestClock, contributor, evidence, suggested } from "../helpers.js";
it.each([
  ["scope", { ...suggested, scope: { type: "project" as const, id: "api_key=do-not-store" } }, evidence],
  ["session", suggested, { ...evidence, session_id: "password=do-not-store" }]
])("scans credentials in %s identifiers", (_name, candidateFact, candidateEvidence) => {
  expect(() => createProposal({ operation: "add_fact", target_fact_ids: [], suggested_fact: candidateFact, evidence: candidateEvidence, reasoning: "长期偏好", confidence: "high" }, { ...contributor, sessionId: candidateEvidence.session_id }, new TestClock(), { next: () => "proposal.00000001" })).toThrowError(CoreError);
});
it.each(["Authorization: Bearer abcdefghijklmnop", "Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l", "https://user:password@example.com/private", "ghp_abcdefghijklmnopqrstuvwxyz123456"])("blocks high-confidence credential %s before ID generation", (secret) => { let calls = 0; try { createProposal({ operation: "add_fact", target_fact_ids: [], suggested_fact: { ...suggested, statement: secret }, evidence, reasoning: "candidate", confidence: "high" }, contributor, new TestClock(), { next: () => { calls++; return "proposal.00000001"; } }); throw new Error("expected"); } catch (error) { expect(error).toBeInstanceOf(CoreError); expect(JSON.stringify((error as CoreError).details)).not.toContain(secret); } expect(calls).toBe(0); });
it("allows ordinary authorization discussion without credential material", () => { expect(() => createProposal({ operation: "add_fact", target_fact_ids: [], suggested_fact: { ...suggested, statement: "HTTP Authorization header should be documented without values" }, evidence, reasoning: "documentation preference", confidence: "high" }, contributor, new TestClock(), { next: () => "proposal.00000001" })).not.toThrow(); });
it("rejects sensitive text before generating an ID and does not echo it", () => {
  let calls = 0; const marker = "SECRET_MARKER_password: hunter2";
  try { createProposal({ operation: "add_fact", target_fact_ids: [], suggested_fact: { ...suggested, statement: marker }, evidence, reasoning: "长期偏好", confidence: "high" }, contributor, new TestClock(), { next: () => { calls++; return "proposal.00000001"; } }); throw new Error("expected rejection"); }
  catch (error) { expect(error).toBeInstanceOf(CoreError); expect((error as CoreError).code).toBe("SENSITIVE_CONTENT_REJECTED"); expect(JSON.stringify((error as CoreError).details)).not.toContain(marker); }
  expect(calls).toBe(0);
});
