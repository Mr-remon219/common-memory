import { afterEach, describe, expect, it } from "vitest";
import { CoreService } from "../../src/core/service/core-service.js";
import type { RecallPlan } from "../../src/core/contracts/dto.js";
import type { SuggestedFact } from "../../src/core/contracts/types.js";
import { TestClock, TestIds, authority, contributor, evidence, suggested, tempRoot } from "../helpers.js";

let cleanup: () => void = () => undefined;
afterEach(() => cleanup());

function setup(): CoreService {
  const root = tempRoot(); cleanup = root.cleanup;
  const core = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids: new TestIds() });
  expect(core.initialize().ok).toBe(true);
  confirm(core, { ...suggested, statement: "修改陌生系统前必须先解释数据流", kind: "constraint", priority: "core" });
  confirm(core, { ...suggested, statement: "Windows 网络故障通过重置代理配置修复", kind: "event", priority: "normal", tags: ["Windows", "网络"] });
  return core;
}

function confirm(core: CoreService, fact: SuggestedFact): void {
  const proposed = core.propose({ operation: "add_fact", target_fact_ids: [], suggested_fact: fact, evidence, reasoning: "recall fixture", confidence: "high" }, contributor);
  if (!proposed.ok) throw new Error(proposed.error.message);
  const approved = core.approve({ proposal_id: proposed.data.proposal_id, expected_store_revision: proposed.store_revision!, note: null }, authority);
  if (!approved.ok) throw new Error(approved.error.message);
}

function plan(core: CoreService): RecallPlan {
  const info = core.repositoryInfo(); if (!info.ok) throw new Error(info.error.message);
  return {
    contract_version: "recall_plan_v1",
    request_id: "recall_test_0001",
    expected_knowledge_revision: info.data.knowledge_revision,
    mode: "model_led",
    queries: ["Windows 网络", "网络 代理 修复"],
    reason: "multi-query lexical plan",
    request: { query: "Windows 网络怎么修复过？", scopes: ["global"], max_context_bytes: 12_000, limit: 10 },
  };
}

describe("CoreService.recall", () => {
  it("fuses multiple queries once and preserves deterministic core boundaries", () => {
    const core = setup();
    const recalled = core.recall(plan(core));
    expect(recalled.ok).toBe(true);
    if (!recalled.ok) return;
    expect(recalled.data.pack.boundaries.map((item) => item.statement)).toEqual(["修改陌生系统前必须先解释数据流"]);
    expect(recalled.data.pack.relevant).toHaveLength(1);
    expect(recalled.data.pack.relevant[0]?.statement).toContain("重置代理配置");
    expect(recalled.data.pack.relevant[0]?.reason).toContain("rrf:queries:0,1");
    expect(recalled.data.pack.knowledge_revision).toBe(recalled.knowledge_revision);
  });

  it("rejects a plan based on a stale knowledge revision before retrieval", () => {
    const core = setup(); const stale = plan(core);
    confirm(core, { ...suggested, statement: "用户默认使用中文", priority: "normal" });
    const recalled = core.recall(stale);
    expect(!recalled.ok && recalled.error.code).toBe("STALE_REVISION");
  });
});
