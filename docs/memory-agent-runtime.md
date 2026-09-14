# Memory Agent Runtime：v0.4.0 三层架构

研究基线：Common Memory `7b777a1`；Pi Agent Core / pi-ai **0.85.1**。
这些说明描述 v0.4.0；npm 0.3.9 不具有此架构。

## 研究与实施决定

官方依据是 [Pi v0.85.1](https://github.com/earendil-works/pi/tree/v0.85.1)，而非搜索摘要或 Coding Agent 的内部会话接口：

- [Agent README](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/README.md)：独立 `Agent`、工具、顺序执行、订阅者等待屏障、`shouldStopAfterTurn`。
- [Agent 类型](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/types.ts)与 [loop](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/agent-loop.ts)：`terminate` 只有整个工具批次都终止时才有效，不能单独保证提交后停止。
- [pi-ai 类型与 provider](https://github.com/earendil-works/pi/tree/v0.85.1/packages/ai/src)：模型 capability、请求选项、custom fetch、上下文估计、请求重试。
- [Responses](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/api/openai-responses.ts)与 [Completions](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/api/openai-completions.ts)：直接 `stream` 在未指定 `maxTokens` 时省略输出限制；`streamSimple` 会补默认值，因此不能用于 Unlimited。Responses SDK 对小于 16 的显式值会提升；本 Runtime 保留用户原值，让服务商明确接受或拒绝，不暗中提高用户上限。

按批准计划依次进行：测试夹具精简 → 中立契约及持久 Bundle → Core 只读 capability/coverage → 独立 Pi Runtime → 配置、TUI 与工具协议夹具迁移 → 删除旧 Model Layer → 全量与真实安装包验证。

## 三层权威

```text
Service Agents (Pi / Codex / Work / MCP / CLI)
    → Core ingress / durable queue
    → MemoryTask + authorized read capabilities
    → Memory Agent Runtime (Pi Agent Core + pi-ai)
    → memory_maintenance_v2 proposal
    → Core validation / admission / guards / commit
    → canonical Markdown + minimal receipt
```

- **Service** 验证实际投递身份、保留已有来源、整理结构、调用 Core，不调用维护模型或挑选长期记忆。
- **Core** 是 `src/v2/` 与 `src/core/`；`Writer` 保留名称但只借用中立的 `MemoryAgentRuntime`。Core 决定披露、来源、证据、写范围、是否准入、事务、回执和恢复。Canonical Markdown 仍是事实源，SQLite 仍是不可重建的持久队列/租约/来源链接存储。
- **Runtime** 是 `src/memory-agent-runtime/`；System、工具定义、模型、推理、请求和 Agent loop 集中于此。每次领取创建新 `Agent`，不带入其他任务的会话、工作笔记或密钥状态。不装入 Coding Agent 的 shell、文件工具、skills、插件、子 Agent 或会话数据库。
- `src/config/runtime.ts` 只负责组合、冻结私有凭据和网络路径、关闭资源。Core 不导入 Pi，Runtime 不导入 Core 的 SQLite、canonical 或事务实现，服务接入不直接调用 Runtime 智能。边界脚本同时检查真正的 `src/v2/` 和 `src/core/`。

## 持久 Ingest Bundle

所有观察，包括一个字符，都在 `RuntimeStore.enqueue` 的同一事务内生成 `ingest_bundles` 与 `ingest_blocks`。`ingest_<observationId>` 是稳定本地标识；外部模型只能使用该次 Core 授权闭包中存在的 handle。Block 表记录：ID、父 ID、kind、顺序、字段、原文范围。

assistant/tool 消息也在 `SessionIngress.capture` 的同一事务内生成 `session_ingest_bundles` / `session_ingest_blocks`，以稳定的 `session_ingest_<messageId>` 引用原 session 消息。它们不是 observations，永远不提供 evidence。共享结构解析保留 conversation 父节点及 section/code/quote 等子节点；message role、顺序、当前/前轮与独立 `conversation_context` 授权由 Core 读取时标注。

不复制正文：`observations.text` 仍是该观察的唯一持久正文；assistant/tool 上下文仍由已有 `session_messages.text` 拥有。Block range 是 JavaScript 字符串坐标，工具分页是经过校验、不会切断 UTF-8 字符的字节坐标。Label、来源 metadata、大小、状态由 Core 在授权读取时提供，不在新的索引里另存一份可能被遗忘的标题/正文。

kind 仅表示 section、paragraph、quote、code、list、table 等结构，绝不表示 fact、preference、identity 或 goal。保留空白、标题层级、fenced code、条件、引用与顺序；结构解析不是语义总结。

新 Markdown 导入是**一个完整来源、一个 observation/bundle**，无固定 32 KiB 分批或 256 KiB 文件上限。Init 是另一个入口，不承接 Markdown 导入的业务。两者仍分别属于 `agent_observation` 与 `document_import`，不能冒充用户，也不能单独作为忘记用户记忆的证据。

旧数据库的 backfill 在 SQLite 事务里增加范围，不改 observation/job/lease/receipt ID、状态或来源链接。观察和上下文 backfill 都保留 NUL 字节与 NULL，事务中断不留下部分 ranges；NULL 正文只获得不可用 owner 映射，不重建正文。上下文正文清空或标记 unavailable 都会删除其 ranges，重开/重试保持相同 handle。forget、人工文档修改后的来源清理、processed prune 清空原 owner 时，trigger 同事务删除范围；重放相同身份不恢复正文。

旧 v1 多 part 导入保留原队列和回执边界。按 **原确定性 namespace + 内容 digest + scope** 查重，重导入时返回实际旧 parts/status，不根据文件名猜测，不恢复已清理内容，也不自动复活 dead/quarantined。若 v1/v2 同时存在则明确冲突，不能悄悄合并。一次任务的 legacy parent manifest 明确标记 `legacy_subset` 和原 part 数，只授权已领取的子集，不假称整个旧来源已读。

## MemoryTask 与 Tools

`src/core/contracts/memory-agent.ts` 定义可替换的运行边界。Task 只有请求 ID、时间、Bundle 概要、snapshot handle、输出 schema 与可选的 trusted task_kind；**没有输入或 canonical 正文**。

| 工具 | 能力 |
| --- | --- |
| `inspect_ingest` | 每页最多 32 个结构描述，带 hierarchy、kind、size、provenance/evidence/context-only metadata |
| `read_ingest` | 每页最多 8 KiB 原文，验证 handle/block/连续 offset，返回 next 和完整权威 descriptor；直接按有效 ID 读取也包含相同来源/结构/证据 metadata，不强制先 inspect；可重新读取 |
| `inspect_memory` | 查看准确的 authorized snapshot manifest，按 target 分页读取；无文件路径、全局检索或 SQL |
| `processing_state` | 本次尝试的当前材料完整读取状态；不是“模型已经理解”的证明 |
| `record_working_notes` | 同一个 Memory Agent 的临时草稿、条件和 source/block references；仅 Runtime 内存，context-only，不是证据 |
| `submit_memory_decision` | 一次性提交 proposal，不能写盘；第一份有效提交终止，后续工具不能修改它 |

snapshot 是 Core 取得的准确短期快照，Runtime 不重新打开文件。提交后 Core 仍执行原完整 snapshot CAS。工具闭包在尝试结束即失效，每次读取检查 signal 与 lease。

Core 要求**当前材料全部读完**才允许任何决定，包括 ignore：用户正文、import gaps、当前轮已授权上下文和条件都算；拒绝披露的上下文明确 unavailable，历史尾上下文为可选且非证据。编辑任一 target 前必须完整读过其快照。没有 skip 或按部分 coverage 消费队列的路径。同一 Agent 中经 Core 许可的恢复保留当前授权读取进度、推理和笔记；重启进程或重新领取任务必须建立新 grant 并重新完整读取，部分读取不算成功。

## Prompt / Context / Limits

Runtime 仍拥有 System；Core 仅接受恰好 64 位小写十六进制的 Runtime `promptDigest`，任何格式错误都在 ignore 消费或提交之前拒绝，不把任意文本写进回执。

System 只教维护行为、来源/条件的语义使用、工具工作流及 retain/forget/maintain/ignore。机器可验证的最终 authority 留在 Core。输入和工作笔记始终是数据，不能修改系统指令。

- Core 接受的 `memory_maintenance_v2` schema、ev 引用、import overwrite/forget guards、writableScopes、project checks、canonical patch 算法、CAS、租约/回执提交顺序没有被 Agent 替换。
- 默认 **Max Input / Max Output = Unlimited**：缺省/null 不额外加入 Common Memory IO cap，不等于无限服务商能力。显式旧 disclosure 字节限制、输出 token 限制仍执行。文档 8/16 KiB 软/硬预算和会话暂存资源预算独立保留。
- Context Window 来自精确匹配的固定 pi-ai 官方 catalog 与官方 endpoint；当前已验证匹配为 OpenAI Responses；选择时持久记录 catalog version/digest，不保存 Pi Model 内部结构。记录不替代 Runtime 独立核实能力。其他 endpoint、网关或未匹配模型显示 **Unknown/custom**，不从模型名或 `/models` 数量猜测。
- 已知 window 的压力处理使用 pi-ai `estimateContextTokens`（provider usage + trailing estimate），20% 工程余量仅用于判断压力，不是新输出上限。只有同一 Agent 已保存工作草稿时才能淘汰旧的完整 model/tool groups；保留任务、草稿、source/block 引用和最近完整组。没有可保留的进度或仍放不下则明确失败。遵守 Pi 0.85.1 契约，`transformContext` 本身正常返回安全上下文；stream 边界用终止 error event 停止，不再调用 provider，随后返回原始 context 诊断。
- Unknown/custom 不按虚构 window 或“六轮”阈值丢上下文；服务商溢出明确失败。分页并不保证任意大来源都能在有限 window/期限内完成，复杂跨页判断仍需评测。模型必须在需要精确措辞时重新读取支持材料，草稿不能替代 Core evidence。
- 默认每次最多 **64 个模型轮次**，Advanced Settings 可设置 1–1024；**没有整项维护任务的墙钟期限**。保留默认 30 秒请求头等待、120 秒流无进展界限，以及取消和租约 fencing。耗尽保留持久工作，不标记成功。
- Provider 明确禁用 SDK 私有重试。Core 持久记录初次执行之外最多五次自动恢复，Agent 修复、队列重领、崩溃和配置恢复共用额度。显式 retry 不重置身份或累计计数。
- 工具/提案错误只回传固定错误码和有界 schema 路径/关键字，不回传原异常、实参值或未知属性名；Core 仍重新验证。分页句柄混用、漏读 target、误用 section 标题等可在同一 Agent 内申请有界修复。
- 内置 skills 只发现名称/描述，经 `load_memory_skill` 精确选择并加载后供 Agent 使用；不扫描用户/项目目录，不执行脚本或 shell。skills 不授予任何 Core 权限。

工作笔记、Agent transcript、reasoning、原始输出、provider error body 都不进入永久回执。usage 汇总所有模型轮次。没有统一 refusal 标记的 pi-ai 输出不会靠文本猜拒绝；无最终工具提交就是失败。

## 公共 API 与升级

移除 `MemoryModelPort`、`ApprovedModelRequest`、Responses/Chat MemoryModel classes 和 `createConfiguredMemoryModel`。
使用 `Writer({agent: MemoryAgentRuntime, ...})`，或原来的 `createConfiguredWriter(config)`。
`createConfiguredMemoryAgent(config)` 提供 owned Runtime，使用后 `await close()`；普通 Writer 仍只借用 neutral port，不关闭借来的 Runtime。

升级写端前，安排旧 writer/MCP/drain 停写并备份整个 dataRoot。当前协议迁移在备份落盘后事务化升级，并通过所有持久表的连接 capability trigger 拒绝旧写端；活跃旧租约或并发变化阻止迁移。不要混用新旧写端，更不能删除 SQLite“迁移”。详见[可靠性与恢复记录](reliability-refactor.md)。TUI 的 Provider → URL → Key → Model 流程和现有接入操作不变。连接测试改为真正的合成 inspect/read/submit 工具链，不读取或写入用户记忆。

## 验证边界

测试先复用临时目录、分页读取和 scripted provider fixtures；淘汰旧独立 JSON-envelope decoder 测试，改测真实 Pi Agent + SSE/tools。逐交互封批及退出交接由真实 Pi SDK 合成 provider 测试覆盖；来源伪装、授权、独立进程 drain、强杀后的回执恢复等独有测试保留。

重点文件：`tests/v2/ingest.test.ts`、`tests/memory-agent-runtime/{agent,provider}.test.ts`、`tests/v2/{writer,writer-recovery,session}.test.ts` 以及 MCP/CLI configured-loop tests。运行 `node scripts/verify.mjs`，build 后 `npm run test:consumer`；脚本假 provider 可用 `npm run test:provider-smoke`。

Linux 自动检查不证明 Windows/WSL、Desktop UI 信任和真实模型语义质量。真实 WSL 仍需安装包后的独立实测，实时模型/个人数据不属于默认测试。

## 外部 Tool / 命令兼容性清单

内部工具不是服务商接入的另一套 MCP API。下列外部名称、固定权限、身份 namespace 与成功/排队语义保留：

| 外部入口 | 保留的契约 / 本次迁移 | 主要覆盖 |
| --- | --- | --- |
| MCP relay `memory_submit_user_turn` | 原 submission/conversation/context 身份与 strict schema；接受只表示 queued；新观察同事务产生 Bundle；显式 MCP 调用请求及时 flush。缺省不再隐含源文本 cap，显式 UTF-8 字节 cap 仍在 ingress 检查，stdio framing limit 单独公布 | `tests/mcp/ingress.test.ts`, `protocol.test.ts` |
| MCP init `memory_init` | 原 importId/sourceLabel/basis/understanding/gaps 及 namespace、重复/冲突行为；仍独立 attributed import；去掉隐式 32/4 KiB cap，不改变固定 init/read/relay capability | 同上与 `tests/cli/integration-init.test.ts` |
| MCP read `memory_read` / `memory_status` | read 仅授权 canonical；status 返回原 connection 或来源状态、retainedIn/diagnostic，无正文；read 进程仍不打开 SQLite，不能提交/初始化 | `protocol.test.ts`, `ingress.test.ts`, installed consumer |
| Pi `memory_read`, `memory_status`, `memory_init`, `/memory`, `/memory-refresh`, `/memory-flush` | 原生 SettingsList 页面浏览/查找、用户 prompt 调整、逐次确认的 attributed 导入、状态/授权重试；沿用 Core ingress 和共享 next 指引，不复制 MCP server，不直接调用 Memory Agent；浏览其他授权项目不扩大模型工具范围或注入 | `tests/v2/pi-memory.test.ts`, `pi-integration.test.ts`, `pi-sdk-capture.test.ts` |
| CLI `import` | 原 flags/作者/label/scope 与状态结果；新来源一 observation，旧 v1 exact namespace 保留 parts/status/receipts，不复活 purged/dead/quarantined | `tests/cli/import.test.ts`, `tests/v2/ingest.test.ts` |
| CLI `show`, `status`, `flush`, `retry`, `project list/register/remove` | 原命令、授权、完整只读输出、排队重试、注册不授权且移除不删 Markdown | reader/writer tests、`tests/cli/tui.test.ts`, installed consumer |
| CLI `codex-hook`, `work-hook`, `session-refresh`, `session-drain`, `codex-config`, `work-config`, `mcp`, `mcp-config` | 原 host 投递身份、事件语义、payload、启动固定 profiles 和诊断；后台 drain 现在组合独立 Runtime，不改 hook 协议 | CLI host/session tests、真实子进程 recovery；WSL 实测仍另行要求 |
| TUI 记忆修改 / 模型连接测试 | 修改仍进入用户观察与 Core；连接测试改为无用户数据的真实工具链；不直接编辑 canonical | `modify-memory.test.ts`, `network-test.test.ts`, `setup.test.ts` |
| JS `chunkMarkdown` / 旧大小常量 | **保留公开导出但 deprecated**，隔离在 `src/v2/compat/markdown-chunks.ts`，只供已有 standalone 调用者；不是新导入、模型或迁移的路径/上限 | 原 standalone helper 行为测试保留；共享 parser 的 lossless/inline-backtick/大块读取另测 |

内部新增的 `inspect_ingest/read_ingest/inspect_memory/processing_state/record_working_notes/submit_memory_decision` 只存在于一次 Memory Agent 尝试。MCP `memory_read` 及 Pi 用户读取工具不会被重新命名或变成这些私有工具。对外 MCP 另提供同一授权 canonical read 的 Resources/template/completion（仅 `read` profile），不是 Bundle 访问权；工具的 schema、错误恢复与 `next` 调用指引见 [MCP 使用说明](usage.md#agent-call-flow-and-resources-current-source-unreleased)。

显式输入 cap 分两个检查：Core 的完整授权源字节预算，以及 Runtime 每个实际序列化 HTTP payload 的预算（包含系统/工具/schema/当前上下文）。Core 先移除可选前轮上下文，再将末尾**完整**观察/会话 turn 放回 pending；当前 user/steer/assistant/tool 组不可拆开。仅真正单组超限才整体 quarantine，不能因为两组相加超限而隔离本可单独处理的一组。Schema/模型上下文本身导致的 wire 超限仍会明确失败，不偷偷扩大显式 cap。

当前 v0.4.1 源码补充：[显式编辑、输入字节限制与按需读取](edit-and-input-contract.md)。旧观察默认 observation；原生编辑单请求单任务，结果随原回执恢复。maxExcerptBytes 统一约束完整序列化来源，deprecated maxCandidateBytes 仍取更严格约束；maxTotalBytes 仍约束完整批次与总 wire。新 memory_read 同范围替代旧快照，不自动刷新。
