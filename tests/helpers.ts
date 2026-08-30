import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock, IdGenerator } from "../src/core/contracts/ports.js";
import { governanceAuthority, trustedContributor } from "../src/core/contracts/ports.js";
import type { SuggestedFact } from "../src/core/contracts/types.js";

export class TestClock implements Clock {
  constructor(public value = "2026-01-01T00:00:00.000Z") {}
  now(): Date { return new Date(this.value); }
}
export class TestIds implements IdGenerator {
  count = 0;
  next(prefix: "fact" | "proposal" | "review" | "repository" | "transaction"): string { this.count++; return `${prefix}.${String(this.count).padStart(8, "0")}`; }
}
export function tempRoot(): { path: string; cleanup(): void } { const path = mkdtempSync(join(tmpdir(), "common-memory-")); return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }; }
export const contributor = trustedContributor("local_user", "session-1");
export const authority = governanceAuthority();
export const suggested: SuggestedFact = { statement: "用户默认使用中文交流", kind: "preference", scope: { type: "global", id: null }, priority: "core", valid_from: null, expires_at: null, tags: ["communication", "中文"] };
export const evidence = { provenance_type: "user_statement" as const, session_id: "session-1", reference: "message-1", observed_at: "2026-01-01T00:00:00.000Z" };
