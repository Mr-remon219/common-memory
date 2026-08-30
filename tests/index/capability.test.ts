import { expect, it } from "vitest";
import { probeIndexCapability } from "../../src/core/index/capability.js";
it("probes the actual built-in SQLite FTS5 trigram capability", () => { const capability = probeIndexCapability(); expect(capability.fts5).toBe(true); expect(capability.trigram).toBe(true); expect(capability.sqlite_version).toMatch(/^3\./); });
