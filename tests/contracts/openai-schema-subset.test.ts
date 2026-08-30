import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("keeps MemoryAnalysis outside the four-file Canonical bundle and inside the OpenAI subset", async () => {
  const { SCHEMA_FILES } = await import("../../src/core/contracts/schema-registry.js"); expect(SCHEMA_FILES).toHaveLength(4); expect(SCHEMA_FILES).not.toContain("memory-analysis.v1.schema.json");
  const schema = JSON.parse(readFileSync("schema/memory-analysis.v1.schema.json", "utf8")); const text = JSON.stringify(schema); for (const keyword of ["uniqueItems", "oneOf", "allOf", "unevaluatedProperties"]) expect(text).not.toContain(`\"${keyword}\"`); expect(schema.type).toBe("object"); expect(schema.additionalProperties).toBe(false);
});
