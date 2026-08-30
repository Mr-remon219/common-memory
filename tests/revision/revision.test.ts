import { expect, it } from "vitest";
import { framedRevision } from "../../src/core/revision/hash.js";
it("revision framing is path-order and separator stable", () => {
  const a = framedRevision("knowledge", [{ path: "memory\\facts\\a.yaml", bytes: Buffer.from("a\n") }, { path: "memory/facts/b.yaml", bytes: Buffer.from("b\n") }]);
  const b = framedRevision("knowledge", [{ path: "memory/facts/b.yaml", bytes: Buffer.from("b\n") }, { path: "memory/facts/a.yaml", bytes: Buffer.from("a\n") }]);
  expect(a).toBe(b); expect(a).toBe("sha256:85785e434439ac2c9e1a124905d33380e8bb36302a06040b894f44f4a34b4d13");
});
