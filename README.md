# Common Memory Core

Common Memory Core 是 Node.js 24 / TypeScript 的本地权威记忆库。Canonical YAML 是唯一事实源，SQLite FTS5 是可重建索引；远程模型只提供无权建议，所有写入由本地 Core policy 决定。

## 能力

- 人工 `propose` / `approve` / `editApprove` / `reject`
- `MemoryManager.extract` 与后台 `consolidate`
- 用户可配置 Base URL 的 OpenAI-compatible Responses API 原生 `fetch` adapter
- 严格 MemoryAnalysis v1 Structured Outputs、外发前敏感扫描与显式 disclosure allowlist
- 原子自动批次（Proposal + approved Review + Fact mutation）、双 revision guard、完整幂等
- 治理日志与补偿式 `previewUndo` / `applyUndo`
- 可重启 SQLite scheduler；数据库只保存 observation ID/digest/scope/provenance 的严格投影和净化运行状态

## 首次启动配置

```bash
npm run build
node dist/cli/main.js
# 安装为 package 后也可直接运行：common-memory
```

无参数启动会打开 TUI。首次运行必须先配置：

- OpenAI-compatible Base URL，例如 `https://api.openai.com/v1`
- 模型名称
- API Key
- 本地数据目录
- 允许远程发送的 scope 和 evidence 类型

Base URL 会保留网关路径前缀并自动追加 `/responses`。因此兼容服务必须实现 OpenAI Responses API 和严格 JSON Schema Structured Outputs；只实现 `/chat/completions` 的服务不能直接使用。

配置保存在 `~/.common-memory/config.json`。API Key 不进入 JSON，而是由 TUI 写入权限为 `0600` 的 `~/.common-memory/.env`；仓库中的 `.env.sample` 只提供变量名模板。运行时只将该文件加载进进程环境，不显示或记录密钥。可用 `COMMON_MEMORY_HOME` 改变配置目录。

程序也可以直接使用相同配置：

```ts
import {
  CoreService,
  MemoryManager,
  createConfiguredMemoryModel,
  loadConfig
} from "common-memory-core";

const config = loadConfig();
if (!config) throw new Error("Run common-memory first");
const core = new CoreService({ dataRoot: config.dataRoot });
const model = createConfiguredMemoryModel(config);
const manager = new MemoryManager({
  core,
  model,
  observations: observationSource,
  disclosurePolicy: config.disclosure
});
```

也可以直接构造 adapter，并通过 `baseUrl` 指定服务根地址。每次 Responses 请求都强制 `store: false` 和 strict `text.format.json_schema`。API key 只进入 `Authorization` header；原始秘密、transcript、prompt、response、refusal 文本与 HTTP error body 不落盘、不进入错误或治理记录。

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

不实现 OpenAI SDK、非 Responses 协议 provider、本地模型、MCP、Pi 运行时接入、完整记忆治理 TUI、embedding、向量库、图检索、Git 远端同步、hard delete 或 schema migrator。当前 TUI 只负责首次配置、重新配置和状态查看。
