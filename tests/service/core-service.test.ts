import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoreService } from "../../src/core/service/core-service.js";
import { TestClock, TestIds, authority, contributor, evidence, suggested, tempRoot } from "../helpers.js";
const cleanups: Array<() => void> = []; afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function setup() { const root = tempRoot(); cleanups.push(root.cleanup); const clock = new TestClock(); const ids = new TestIds(); const service = new CoreService({ dataRoot: root.path, clock, ids }); expect(service.initialize().ok).toBe(true); return { service, clock, root: root.path }; }
describe("CoreService governance to query/index", () => {
  it("keeps proposals invisible, approves atomically, and rebuilds searchable FTS", () => {
    const { service } = setup(); const initial = service.get({ scopes: ["global"] }); expect(initial.ok && initial.data.facts).toHaveLength(0);
    const proposed = service.propose({ operation: "add_fact", target_fact_ids: [], suggested_fact: suggested, evidence, reasoning: "用户明确陈述长期语言偏好", confidence: "high" }, contributor); expect(proposed.ok).toBe(true);
    const pending = service.get({ scopes: ["global"] }); expect(pending.ok && pending.data.facts).toHaveLength(0);
    if (!proposed.ok) throw new Error("proposal failed"); const approved = service.approve({ proposal_id: proposed.data.proposal_id, expected_store_revision: proposed.store_revision!, note: null }, authority); expect(approved.ok).toBe(true);
    const summary = service.summary({ scopes: ["global"] }); expect(summary.ok && summary.data.summary).toContain("中文交流");
    const search = service.search({ query: "默认使用中文", scopes: ["global"], limit: 10 }); expect(search.ok).toBe(true); if (search.ok) { expect(search.data[0]?.fact.statement).toContain("中文"); expect(search.data[0]?.raw_bm25).toBeTypeOf("number"); }
    const diag = service.diagnose(); expect(diag.ok && diag.index_revision).toBe(diag.ok ? diag.knowledge_revision : null);
  });
  it("rejects malformed add and contributor session mismatch without changing store", () => {
    const { service } = setup(); const before = service.diagnose(); if (!before.ok) throw new Error();
    const malformed = service.propose({ operation: "add_fact", target_fact_ids: ["fact.99999999"], suggested_fact: suggested, suggested_expiration: { expires_at: "2026-01-01T00:00:00.000Z", reason: "mixed" }, evidence, reasoning: "bad", confidence: "high" } as unknown as Parameters<CoreService["propose"]>[0], contributor); expect(!malformed.ok && malformed.error.code).toBe("VALIDATION_FAILED");
    const mismatch = service.propose({ operation: "add_fact", target_fact_ids: [], suggested_fact: suggested, evidence: { ...evidence, session_id: "forged" }, reasoning: "bad", confidence: "high" }, contributor); expect(!mismatch.ok && mismatch.error.code).toBe("VALIDATION_FAILED"); const after = service.diagnose(); expect(after.store_revision).toBe(before.store_revision);
  });
  it("recalls the frozen Chinese question, warns on stale index, then rebuilds", () => {
    const { service } = setup(); const p = service.propose({ operation: "add_fact", target_fact_ids: [], suggested_fact: suggested, evidence, reasoning: "语言", confidence: "high" }, contributor); if (!p.ok) throw new Error(); service.approve({ proposal_id: p.data.proposal_id, expected_store_revision: p.store_revision!, note: null }, authority);
    const first = service.search({ query: "用户默认使用什么语言？", scopes: ["global"] }); expect(first.ok && first.data.some((result) => result.fact.statement.includes("中文"))).toBe(true); const negative = service.search({ query: "数据库远端同步", scopes: ["global"] }); expect(negative.ok && negative.data).toHaveLength(0);
    const p2 = service.propose({ operation: "add_fact", target_fact_ids: [], suggested_fact: { ...suggested, statement: "用户修改陌生系统前先看计划", kind: "constraint" }, evidence, reasoning: "边界", confidence: "high" }, contributor); if (!p2.ok) throw new Error(); const approved = service.approve({ proposal_id: p2.data.proposal_id, expected_store_revision: p2.store_revision!, note: null }, authority); expect(approved.warnings).toEqual(["INDEX_OUTDATED"]); const get = service.get({ scopes: ["global"] }); expect(get.warnings).toEqual(["INDEX_OUTDATED"]);
    const rebuilt = service.search({ query: "陌生系统计划", scopes: ["global"] }); expect(rebuilt.ok).toBe(true); expect(rebuilt.warnings).toEqual([]);
  });
  it("detects missing or altered FTS rows and replaces an existing index", () => {
    const { service, root } = setup(); const p = service.propose({ operation: "add_fact", target_fact_ids: [], suggested_fact: suggested, evidence, reasoning: "语言", confidence: "high" }, contributor); if (!p.ok) throw new Error(); service.approve({ proposal_id: p.data.proposal_id, expected_store_revision: p.store_revision!, note: null }, authority); service.search({ query: "中文交流", scopes: ["global"] }); const path = join(root, "index", "memory.sqlite");
    let db = new DatabaseSync(path); db.exec("DELETE FROM facts_fts"); db.close(); expect(service.search({ query: "中文交流", scopes: ["global"] }).ok).toBe(true);
    db = new DatabaseSync(path); db.exec("UPDATE facts_fts SET statement='tampered' WHERE rowid=1"); db.close(); const repaired = service.search({ query: "中文交流", scopes: ["global"] }); expect(repaired.ok && repaired.data.length).toBeTruthy(); expect(service.rebuildIndex().ok).toBe(true);
  });
  it("supports more than sixteen proposals at one clock tick", () => { const { service } = setup(); for (let index = 0; index < 17; index++) { const result = service.propose({ operation: "add_fact", target_fact_ids: [], suggested_fact: { ...suggested, statement: `固定时钟候选 ${index}` }, evidence, reasoning: "批量候选", confidence: "high" }, contributor); expect(result.ok).toBe(true); } const diagnosed = service.diagnose(); expect(diagnosed.ok && diagnosed.data.pending_proposals).toBe(17); expect(service.propose({ operation: "add_fact", target_fact_ids: [], suggested_fact: { ...suggested, statement: "第十八条" }, evidence, reasoning: "继续", confidence: "high" }, contributor).ok).toBe(true); });
  it("supports keyword-only Chinese queries with truthful matched fields", () => { const { service } = setup(); const p = service.propose({ operation: "add_fact", target_fact_ids: [], suggested_fact: suggested, evidence, reasoning: "语言", confidence: "high" }, contributor); if (!p.ok) throw new Error(); service.approve({ proposal_id: p.data.proposal_id, expected_store_revision: p.store_revision!, note: null }, authority); for (const query of ["用户 中文", "默认 语言"]) { const result = service.search({ query, scopes: ["global"] }); expect(result.ok && result.data[0]?.matched_fields).toContain("statement"); } });
  it("keeps consecutive approved review revisions valid even at the same clock tick", () => {
    const { service } = setup(); const first = service.propose({ operation: "add_fact", target_fact_ids: [], suggested_fact: suggested, evidence, reasoning: "第一条", confidence: "high" }, contributor); if (!first.ok) throw new Error(); const a = service.approve({ proposal_id: first.data.proposal_id, expected_store_revision: first.store_revision!, note: null }, authority); expect(a.ok).toBe(true);
    const second = service.propose({ operation: "add_fact", target_fact_ids: [], suggested_fact: { ...suggested, statement: "用户在修改陌生系统前需要先看计划", kind: "constraint" }, evidence, reasoning: "第二条", confidence: "high" }, contributor); expect(second.ok).toBe(true); if (!second.ok) throw new Error(); const b = service.approve({ proposal_id: second.data.proposal_id, expected_store_revision: second.store_revision!, note: null }, authority); expect(b.ok).toBe(true); if (a.ok && b.ok) expect(a.data.store_revision).not.toBe(b.data.store_revision); expect(service.diagnose().ok).toBe(true);
  });
  it("fails closed when an approved review revision is tampered", () => {
    const { service, root } = setup(); const p = service.propose({ operation: "add_fact", target_fact_ids: [], suggested_fact: suggested, evidence, reasoning: "长期偏好", confidence: "high" }, contributor); if (!p.ok) throw new Error(); const approved = service.approve({ proposal_id: p.data.proposal_id, expected_store_revision: p.store_revision!, note: null }, authority); expect(approved.ok).toBe(true);
    const directory = join(root, "repository", "memory", "reviews"); const path = join(directory, readdirSync(directory)[0]!); const text = readFileSync(path, "utf8").replace(/resulting_store_revision: sha256:[0-9a-f]{64}/, `resulting_store_revision: sha256:${"0".repeat(64)}`); writeFileSync(path, text);
    const diagnosed = service.diagnose(); expect(!diagnosed.ok && diagnosed.error.code).toBe("STORE_UNAVAILABLE");
  });
  it("rejects stale review and supports immutable rejection", () => {
    const { service } = setup(); const p = service.propose({ operation: "add_fact", target_fact_ids: [], suggested_fact: suggested, evidence, reasoning: "长期偏好", confidence: "high" }, contributor); if (!p.ok) throw new Error();
    const stale = service.reject({ proposal_id: p.data.proposal_id, expected_store_revision: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", note: null }, authority); expect(!stale.ok && stale.error.code).toBe("STALE_REVISION");
    const rejected = service.reject({ proposal_id: p.data.proposal_id, expected_store_revision: p.store_revision!, note: "不采纳" }, authority); expect(rejected.ok).toBe(true); const again = service.reject({ proposal_id: p.data.proposal_id, expected_store_revision: rejected.store_revision!, note: null }, authority); expect(!again.ok && again.error.code).toBe("CONFLICT_DETECTED");
  });
});
