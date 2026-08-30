import { expect, it } from "vitest";
import { canonicalYamlBytes } from "../../src/core/serialization/canonical-yaml.js";
import { parseYamlStrict } from "../../src/core/serialization/parse.js";
import type { Proposal } from "../../src/core/contracts/types.js";
import { evidence, suggested } from "../helpers.js";
const proposal: Proposal = { schema_version: 1, id: "proposal.00000001", operation: "add_fact", target_fact_ids: [], suggested_fact: { ...suggested, tags: ["中文", "communication"] }, evidence, reasoning: "用户明确陈述", confidence: "high", source: { client: "local_user", received_at: "2026-01-01T00:00:00.000Z" }, created_at: "2026-01-01T00:00:00.000Z" };
it("canonicalizes BOM, CRLF, key order and set order", () => {
  const canonical = canonicalYamlBytes("proposal", proposal); const windows = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonical.toString("utf8").replace(/\n/g, "\r\n"))]);
  const parsed = parseYamlStrict(windows, "proposal") as Proposal;
  expect(canonicalYamlBytes("proposal", parsed)).toEqual(canonical);
  expect(canonical.toString()).not.toContain("\r");
});
it("normalizes RFC3339 offsets to UTC before canonical bytes", () => { const offset = { ...proposal, created_at: "2026-01-01T08:00:00+08:00", source: { ...proposal.source, received_at: "2026-01-01T08:00:00+08:00" } }; const bytes = canonicalYamlBytes("proposal", offset); expect(bytes.toString()).toContain("2026-01-01T00:00:00.000Z"); expect(bytes.equals(canonicalYamlBytes("proposal", proposal))).toBe(true); });
it("rejects duplicate YAML keys", () => expect(() => parseYamlStrict(Buffer.from("schema_version: 1\nschema_version: 1\n"), "proposal")).toThrow());
