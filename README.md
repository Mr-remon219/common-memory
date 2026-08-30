# Common Memory Core

Common Memory Core 是 Node.js 24 / TypeScript 的本地权威记忆库。Canonical YAML 是唯一事实源，SQLite FTS5 是可重建索引；远程模型只提供无权建议，所有写入由本地 Core policy 决定。

## 能力

- 人工 `propose` / `approve` / `editApprove` / `reject`
- `MemoryManager.extract` 与后台 `consolidate`
- 固定 `https://api.openai.com/v1/responses` 的原生 `fetch` adapter
- 严格 MemoryAnalysis v1 Structured Outputs、外发前敏感扫描与显式 disclosure allowlist
- 原子自动批次（Proposal + approved Review + Fact mutation）、双 revision guard、完整幂等
- 治理日志与补偿式 `previewUndo` / `applyUndo`
- 可重启 SQLite scheduler；数据库只保存 observation ID/digest/scope/provenance 的严格投影和净化运行状态

## 远程配置

```ts
import { CoreService, MemoryManager, OpenAIResponsesMemoryModel } from "common-memory-core";

const core = new CoreService({ dataRoot: "/local/canonical-root" });
const disclosurePolicy = {
  enabled: true as const,
  allowedScopes: ["global"],
  allowedProvenance: ["user_statement", "user_correction"],
  maxExcerptBytes: 8_000,
  maxCandidateBytes: 4_000,
  maxTotalBytes: 64_000
};
const model = new OpenAIResponsesMemoryModel({
  apiKey: process.env.OPENAI_API_KEY!,
  model: process.env.OPENAI_MODEL!,
  disclosurePolicy
});
const manager = new MemoryManager({ core, model, observations: observationSource, disclosurePolicy });
```

每次 Responses 请求都强制 `store: false` 和 strict `text.format.json_schema`。API key 只进入 `Authorization` header；原始秘密、transcript、prompt、response、refusal 文本与 HTTP error body 不落盘、不进入错误或治理记录。`model` 必须支持 Responses Structured Outputs。

## 信任与失败语义

模型不能创建 ID、时间、source、reviewer 或 authority。人工治理通过根入口 `createLocalUserMemoryControl(core)` 获取受控 facade，原始 capability 构造器不公开。Core 使用不可伪造的 nominal capability，并在一个事务内提交完整自动批次。refusal、超时、取消、网络错误、解码错误、安全阻断、policy reject 或耗尽 stale 重试都不会污染 Canonical Store。Undo 只追加补偿记录，不 hard delete 或改写历史。

`memory-analysis.v1.schema.json` 随包发布，但不属于四项 Canonical schema bundle，不影响 `store_revision`。0.1.0 尚未发布，本次直接更新 Canonical v1；旧预发布数据根会因 schema bundle digest 不匹配而 fail closed，必须重建。

## 验收

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run test:consumer
npm run test:remote-contract
npm pack --dry-run
```

## 非目标

不实现 OpenAI SDK、自定义 base URL、其他 provider、本地模型、MCP、Pi、CLI/TUI、embedding、向量库、图检索、Git 远端同步、hard delete 或 schema migrator。
