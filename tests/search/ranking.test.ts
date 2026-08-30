import { expect, it } from "vitest";
import ranking from "../../fixtures/search/ranking.v1.json" with { type: "json" };
import { normalizeSearchText, unicodeLength } from "../../src/core/search/normalize.js";
it("freezes ranking constants and Unicode normalization", () => {
  expect(ranking.candidate_limit).toBe(100); expect(ranking.tokenizer).toBe("trigram");
  expect(normalizeSearchText("ＡＢＣ  中文\n测试")).toBe("abc 中文 测试"); expect(unicodeLength("中文")).toBe(2);
});
