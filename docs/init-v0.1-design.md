# Init v0.1：跨 Agent 记忆迁移与复用 — 研究、设计与计划

> 历史记录：Pi/Codex 读取频率、捕获、调度和退出行为已由 [会话接入](session-integration.md) 替代。下文旧验收不证明新会话链路。


日期：2026-09-07。分支 `init-v0.1`（worktree），基线 HEAD `a9fc436`（main 同一提交），工作树干净。收尾增量（Markdown 导入、来源授权、WSL 桥接）基于 `3c70c9b`，见 §9。
Node v24.20.0，`@modelcontextprotocol/server` 2.0.0（协议修订 2026-07-28），Pi peer 锁定 0.84.4，
本机 Codex CLI 0.153.4，Windows 侧 ChatGPT/Codex 桌面应用 26.901.51231。

本文保留初始设计与历史验证状态；当前迁移流程与验收边界以 §10 及 [后续 Work 本地证据](init-v0.1-verification.md#work-local-evidence-2026-09-08) 为准。

目标闭环：ChatGPT 桌面版提交既有理解 → Core 处理并持久化 → 本地可查看 → Codex CLI 与 Pi 用同一份 canonical memory 回答“我是谁？”。

本文严格区分四类陈述：**[项目事实]** 来自当前 checkout 代码；**[外部事实]** 来自官方文档/源码并注明访问日期；**[设计选择]**；**[未验证]**。

## 1. 当前项目事实与缺口

[项目事实]（`README.md`、`src/`、`tests/`，HEAD a9fc436）：

| 组件 | 现有能力 | 与闭环相关的缺口 |
| --- | --- | --- |
| Core（`src/v2/`） | Writer：观察队列 → 模型 `memory_maintenance_v2` 决策 → Section 级 Markdown 提交（锁、租约、CAS、回执、恢复）。`CanonicalStore.snapshot` 只供 Writer 使用，构造时会创建目录。 | **没有任何面向消费者的读取接口**；README 明言 "Write-only"。观察 `source` 只接受 `interactive`/`rpc`/`mcp_user_submission` 进入 pending，其他一律隔离；投影没有来源类型字段，模型无法区分用户原话与 Agent 总结。 |
| Pi 扩展（`src/pi-extension/`） | 捕获 `input`/`message_end`，绑定稳定 Entry，稍后 Writer 处理；`/memory-flush`；生命周期 flush。 | **不读取、不注入记忆**；没有 `before_agent_start` 处理器。Pi “基本实现完了”仅指写路径。 |
| MCP（`src/mcp/`） | stdio 服务，`memory_submit_user_turn`（逐字用户表达，需 `--accept-client-reported-user-turns`）与 `memory_status`；`--client-id` 命名空间、`--workspace/--global` 上下文在启动时冻结。 | 无 Init 工具、无读取工具、无能力分档（任何客户端连上即得到相同的工具集）。`memory_status` 只能返回 `processed`，无法区分“处理后未保留”。 |
| 配置（`src/config/`） | `disclosure.allowedProvenance` 枚举含 `user_explicit`/`agent_observation`/`document_import`，但只有 `user_explicit` 被检查。 | `agent_observation`/`document_import` 已有开关无消费者。 |
| CLI | `config/status/flush/retry/project/mcp`。 | 无直接查看 canonical memory 的命令（用户可 `cat` Markdown 文件）。 |

边界检查脚本 `scripts/check-boundaries.mjs` 禁止 `class Recall`、`/src/recall/` 授权写、embedding 等；本次不触碰这些禁区。

## 2. 外部事实（访问日期 2026-09-07）

### 2.1 ChatGPT 桌面版接入方式

来源：`https://developers.openai.com/codex/mcp`（=`learn.chatgpt.com/docs/extend/mcp`）、`learn.chatgpt.com/docs/customization/memories`、`.../docs/use-chatgpt`、`.../docs/enterprise/chatgpt-work-overview`。

- [外部事实] “The ChatGPT desktop app, Codex CLI, and IDE extension support MCP servers and **share MCP configuration for the same Codex host**.” 桌面应用：Settings → MCP servers → Add server，可选 **STDIO** 或 Streamable HTTP。配置落在 `~/.codex/config.toml` 的 `[mcp_servers.<id>]`。
- [外部事实] “ChatGPT web doesn't read local Codex configuration files.” 网页端/Chat 只能用 plugins/远程 HTTPS 连接器（Developer mode）。
- [外部事实] 桌面应用有三种工作方式：Chat、ChatGPT Work（cloud / **local**）、Codex。Work/Codex 共用 Codex harness。
- [外部事实] 记忆来源按表面不同：“ChatGPT web uses ChatGPT memory, while **local Codex clients use a separate local memory store** and controls.” 本地记忆存于 `~/.codex/memories/`（`features.memories`，默认关闭，本机 Windows 侧已开启）。Work 页面称可 “Bring in uploaded files, projects, memories, ChatGPT Library…”。
- [外部事实] Codex host 读取 MCP `instructions` 字段作为 server 级指导（“Keep the first 512 characters self-contained”）；支持 `enabled_tools`/`disabled_tools`、`default_tools_approval_mode = auto|prompt|writes|approve`（`writes` 对未标记只读的工具提示确认）。
- [外部事实] 第三方博文（designrevision/usecarly，2026）仍称“ChatGPT 只支持远程 HTTPS，不支持本地 stdio”，这与官方 Codex host 文档不一致；本设计以官方文档为准，并把博文视为对 **Chat/网页端** 路径的描述。

**结论（对可行性问题 1）**
- 工具能否被发现/调用：[外部事实] 桌面应用的 Codex host 可直接启动本地 STDIO 服务，无需隧道；[未验证] 本机未实际在桌面 GUI 内运行（WSL 无法驱动 Windows GUI），需用户按 §7 步骤执行。
- 调用时能否访问既有理解：按实际可见材料记录。[外部事实，2026-09-08 复核] 官方区分 ChatGPT Memory 与 Codex 本地记忆，并称 Work 不使用 Codex 本地记忆；[本地实测] 用户确认的 Work 本地会话实际注入、读取了 Codex 本地记忆并完成 Init，见后续证据。二者存在差异，不以模式名称推断全部来源或覆盖范围。[未验证] 该会话是否还获得额外云端记忆、其他账号/版本的行为和遗漏量。远程 MCP 只改变传输，不证明源 Agent 可取得更多理解。
- 内容能否送达本地：STDIO 路径天然在本地；本项目 MCP 服务已存在且经协议测试。

### 2.2 Codex CLI

来源：同上 + `learn.chatgpt.com/docs/config-file/config-advanced`、`.../config-reference`。

- [外部事实] `~/.codex/config.toml` `[mcp_servers.<id>]`：`command/args/env/cwd`、`enabled_tools`、`disabled_tools`、`default_tools_approval_mode`、`tools.<tool>.approval_mode`、`tools.<tool>.output_token_limit`；项目级 `.codex/config.toml` 仅受信项目加载。
- [外部事实] Profiles：`~/.codex/<name>.config.toml` 覆盖层，`codex --profile <name>`；一次性覆盖 `-c mcp_servers.<id>.enabled=false`。
- [外部事实] Codex 本地 Memories 默认关闭；验收时需排除（隔离 `CODEX_HOME`）。
- [外部事实] `codex exec --json -C <dir> --skip-git-repo-check` 可非交互运行并输出事件。

### 2.3 Pi 宿主机制

来源：`node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`（0.84.4）。

- [外部事实] `before_agent_start` 在用户提交后、agent 循环前触发，可返回 `systemPrompt`（链式）或注入 `message`；`ctx.cwd` 可用。CLI 支持 `-p`、`-e <ext>`、`--no-extensions`、`--no-context-files`、`--no-session`、`--mode json`。

### 2.4 参考实现（少量、高相关）

- Codex 本地 Memories（官方，`memories` 文档）：后台从会话生成 `MEMORY.md`/摘要，并在新会话注入。与本设计 Pi 路径同型：**读取时以系统提示注入当前状态文档**，不做检索。
- Mem0 hosted MCP（`docs.mem0.ai/platform/mem0-mcp`，2026）：向所有客户端暴露 add/search/update/delete 全套工具，由 Agent 自行决定何时写。作为**反例**：本设计按客户端启动配置分档暴露能力，由 Core 决定写入，Agent 只提交材料。
- `mem0ai/mem0` OpenMemory 已弃用（issue #6078），不作为依据。

### 2.5 本机环境事实

- ChatGPT/Codex 桌面应用在 Windows（`C:\Users\Administrator\.codex\config.toml`，`features.memories = true`，已有 `[mcp_servers.node_repl]`）；Codex CLI 与 Common Memory 在 WSL（`~/.codex`）。**两者不共享 config.toml**，天然隔离；但桌面应用启动 WSL 内 STDIO 服务需 `wsl.exe -e <绝对路径 node> ...`（已验证 `wsl.exe -e` 可用；非登录 shell 无 fnm PATH，必须写绝对路径）。
- 本机没有 `~/.common-memory` 配置，也没有 `OPENAI_API_KEY`：Writer 真实模型调用不可在本会话运行；自动化与演示使用合成 Responses 服务。

## 3. 可行性判断（提示词第四节）

1. **ChatGPT 桌面版**：工具接通可行（本地 STDIO，官方支持）；“既有理解”的来源按本次实际读取材料记录，不按模式名称推断。不把“生成一段总结”当作导出全部内部记忆；Init 记录 `basis` 与 `gaps` 让来源可见。真实桌面 E2E 本会话不可执行 → 标为未验证，提供步骤。
2. **能力边界**：同一 Codex host 共享 `config.toml`，因此**不能靠宿主区分客户端**。设计为：每个 MCP 进程在启动参数上固定能力（`--capability init|read|relay`），服务端只注册对应工具；宿主侧再叠加 `enabled_tools`（Codex）与审批模式；Codex CLI 用 profile/`-c` 关闭 init 服务。任何工具参数（如客户端自报名称）都不作为身份或授权。
3. **部署要求**：STDIO 路径不新增网络端点、隧道或常驻服务。Chat 端实际可见材料可由用户保存为 Markdown，走现有文件导入入口；不需要为此新增远程服务器，也不承诺完整导出。

## 4. 设计

### 4.1 Init 提交什么（[设计选择]）

工具 `memory_init`（仅 `--capability init` 进程注册）：

```
{ importId, contextId, sourceLabel, basis, understanding, gaps? }
```

- `importId`：1–128 位 ASCII id，幂等键，重试复用。
- `contextId`：启动时冻结的允许上下文之一（`global` 或 `project:<id>`）。
- `sourceLabel`：Agent 自述标签（如 `chatgpt-desktop`），**仅作记录，不是身份**。
- `basis`：`saved_memories | chat_history | current_conversation | project_context | mixed | unknown`。
- `understanding`：Agent 实际可见、选定的已有材料，可直接引用或忠实概括（≤32 KiB）；保留原时间、历史目标、条件、项目范围与暂定性质，排除本次迁移执行状态及无依据新增断言。引用仍是 Agent 报告，不获得用户原话权限。
- `gaps`：Agent 无法访问/不确定的部分，以及具体材料来源和覆盖范围（也可在 `understanding` 中说明）；不把 Agent 不知道转换成用户的否定事实。现有 `basis` 枚举不变，产品名称不是来源证明。

整个 payload 以 JSON 作为一条观察写入现有队列，`source = 'agent_import'`。不提供“用户原话”字段：Agent 声称的逐字引用无法核验；需要逐字用户表达的可信本地中继仍走既有 `memory_submit_user_turn`。不接收文档（Markdown 导入见 §6）。

### 4.2 来源区分与 Writer 调整

- 投影每条观察新增 `source_kind: 'user_turn' | 'agent_import'`（由 DB `source` 推导），`agent_import` 观察额外给出 `import: { source_label, basis, gaps }`，`text` 为 `understanding`。输出协议 `memory_maintenance_v2` 不变，历史回执无需迁移。
- 维护提示（随包发布）新增一段：agent_import 是其他 Agent 的总结，不是用户断言；保留时须标明来源性质（例如在 Section 中写明“据 ChatGPT 于 <日期> 导入的理解”）；与已有用户表达冲突时以已有状态为准，可记录差异；**不得作为 forget 的依据**；不得据此清空或整体重写文档。
- 执行器结构性约束（审阅后收紧）：`claim()` 不把 `agent_import` 与用户轮放进同一批；证据全为 `agent_import` 的决策（或 import-only 批次中 `evidence: []` 的 maintain）只能新增 Section（`section: null`）或改写“所有来源链接都是 import”的 Section；`forget` → `UNAUTHORIZED_FORGET_EVIDENCE`，删除/替换用户来源或无来源链接的 Section → `UNAUTHORIZED_IMPORT_OVERWRITE`。语义层面（标注来源、冲突时保留用户状态）仍由模型负责。
- `RuntimeStore.enqueue` 将 `agent_import` 视为 pending 来源。Init 提交后立即 `requestFlush()`，避免等待 6 轮/120 秒阈值；flush 是全库开关，已排队的用户轮也会随之在下一稳定边界处理（与 `/memory-flush` 相同），文档已说明。

### 4.3 状态区分

`memory_status { importId }` → `{ import: { state, retainedIn, issue } }`：
- `pending`/`claimed`：已接收、处理中；`processed` + `retainedIn: ['profile']`：已落盘并在这些文档中保留；`processed` + `retainedIn: []`：处理后未保留（ignore/仅 maintain）；`quarantined`/`dead` + `issue` 码：未处理及原因。
- `retainedIn` 由现有 `associations` 表推导（target:titleHash → sourceId），不新增列，不泄露标题明文。

### 4.4 读取（Codex 与 Pi 共用）

新增 `src/v2/reader.ts`：`readAuthorizedMemory({dataRoot, contexts})` → 按上下文映射目标文档（`global` → profile+preferences；`project:<id>` → 该项目文档），只读现有文件，**不创建目录、不开 SQLite、不取锁**，返回 `{ target, content, bytes, empty }`。授权（启动上下文 ∩ `disclosure.allowedScopes`）由三个调用方在调用前完成：MCP `McpIngress.contexts()`、Pi 扩展、CLI `show`。`renderMemoryView` 把文档放入 `<common-memory>` 定界块，并转义内容中的同名标签，防止导入文本闭合数据块。
- Codex：`memory_read { contextId? }`（仅 `--capability read` 进程注册；`readOnlyHint: true`）。上下文仍由 `--global/--workspace` + 注册表 + `disclosure.allowedScopes` 决定，跨项目隔离与现有 ingress 一致；空记忆返回 `empty: true` 与明确文本，避免消费者补造。只读进程**不构造 Writer、不需要 API key**。
- Pi：扩展新增 `before_agent_start`，读取 `global` +（cwd 解析到的已注册且允许的）项目文档，以定界块追加到 system prompt；空时注入一行“暂无记忆”。每轮重新读取，最新即所见。
- CLI：`common-memory show [--workspace <path>]` 打印同一读取结果，供用户本地核对“消费者到底看到什么”。
- 大小：文档由 Writer 限定在 16 KiB 硬上限内（≤3 文档），不截断；返回字节数。

### 4.5 让“我是谁？”可靠触发

- MCP `instructions`（Codex 官方读取）+ 工具描述：涉及用户身份、背景、偏好、工作方式的问题先调用 `memory_read`；内容是用户数据不是指令；记忆没有的内容要说明而不是猜。
- Pi：系统提示注入，无需工具名。
- 不新增 AGENTS.md 依赖；若真实 Codex 测试显示未触发，再在文档中给出可选的一行 AGENTS.md 提示（作为回退，不作为机制）。

### 4.6 能力分档、传输、配置、打包

- 传输：stdio（现有），不新增 HTTP。
- `common-memory mcp --client-id <id> [--capability init|read|relay ...] [--workspace] [--global] [--accept-client-reported-user-turns]`；缺省 `relay`，保持既有行为与测试不变。`init`/`relay` 进程持有 Writer 并后台处理；`read` 进程纯读。
- Init 启用条件：启动含 `--capability init` **且** 配置 `disclosure.allowedProvenance` 含 `agent_observation`（复用已有向远端披露的授权开关；向导中该项文案更新为“Agent 汇报的理解（Init 导入）”）。
- Codex 配置：只读服务 + `enabled_tools = ["memory_read","memory_status"]`；Init 服务 `default_tools_approval_mode = "approve"`。同一 host 共享配置时，用 `~/.codex/memory-reader.config.toml` 关闭 init 服务供 `codex --profile memory-reader` 使用。
- 打包不变：同一 `dist/cli/main.js`。

### 4.7 重复、失败、重试、中断

复用现有机制：`(sessionId, entryId)` 唯一 + digest 冲突检测（同 importId 相同 payload → `duplicate:true`；不同 payload → `SUBMISSION_CONFLICT`）；durable queue、租约、指数退避、dead-letter 与 `common-memory retry`；文件成功/DB 失败按回执恢复。Init 命名空间 `mcp-init:[clientId, importId]` 与中继命名空间分离。

### 4.8 预览/确认

不在 Core 建审批队列。确认由三层构成：用户在对话中明确要求；宿主对非只读工具的审批（Codex `approve`/`writes`；ChatGPT 对写操作要求确认）；Core 模型筛选 + 安全扫描。事后可见：本地 Markdown、`common-memory show`、`memory_status.retainedIn`。

## 5. 取舍

| 问题 | 候选 | 选择与理由 |
| --- | --- | --- |
| 客户端能力隔离 | A 服务端按启动参数分档；B 仅靠宿主 `enabled_tools`；C 工具参数声明身份 | A（+B 叠加）。C 不可靠且被明确禁止；B 单独存在时其他宿主仍可得到全部工具。 |
| Init 来源类型 | A 单一 `agent_import`；B 允许 Agent 标注“用户原话” | A。Agent 标注无法核验，逐字中继已有专用工具与显式信任开关。 |
| 读取实现 | A 只读文件函数；B 复用 `CanonicalStore.snapshot`；C 检索/索引 | A。B 会创建目录且面向 Writer；C 越界。 |
| 处理触发 | A Init 后立即 flush；B 等待阈值 | A。Init 是显式用户动作，需可观测的落盘时间。 |
| 状态可见性 | A 用 associations 推导 `retainedIn`；B 回执新增明文 | A。不改回执隐私边界。 |

## 6. Markdown 文件导入（收尾时纳入 v0.1，见 §9）

最初评估为“不交付”；收尾阶段明确纳入。设计与 Init 同构：`source = document_import`（provenance 枚举中已有），同一个 Writer，同一套守卫；差别只在输入预处理与来源元数据。详见 §9.2。手动 Markdown 导入仍不能替代 ChatGPT 链路验收。

## 7. 验收与验证分层

1. 合成材料与自动化测试（vitest，fake provider）：能力分档、Init 幂等/冲突/门控、`retainedIn`、forget 守卫、读取隔离/空记忆、Pi 注入、回归。
2. MCP 协议与客户端接入：真实 stdio 子进程（测试）；真实 Codex CLI（隔离 `CODEX_HOME`，只复制 auth）开/关对照；真实 Pi 0.84.4 干净会话开/关对照。以上使用合成事实与隔离 `COMMON_MEMORY_HOME`。
3. 真实 ChatGPT 桌面版 → Core → Codex/Pi：本会话不可执行（GUI 在 Windows、无 API key）；给出步骤与记录模板，结果标注未验证。

## 8. 未验证与需要用户决定

- [未验证] ChatGPT 桌面版实际调用 `memory_init` 及其可用的“既有理解”来源；Work-local 是否能引用云端 Memory。
- [未验证] 真实维护模型对 agent_import 的语义处理质量（与仓库既有立场一致，需显式凭据）。
- [范围] 云端可见材料走用户选定 Markdown；远程 HTTPS 连接器、隧道及完整聊天解析器不在本版范围内。
- [决定] 真实 Writer 联调需要 OpenAI 兼容 API key（本机无）。

## 9. 收尾增量（2026-09-07 下午，基线 `3c70c9b`）

本节记录收尾阶段的研究结论、设计与取舍。四类陈述标记同文首。

### 9.1 研究结论

[项目事实]（HEAD `3c70c9b`，收尾前）：

- `memory_init` → `McpIngress.init` → `encodeAgentImport` JSON 信封 → `RuntimeStore.enqueue(source='agent_import')` + `requestFlush` → `claim()` 以 `source === 'agent_import'` 单独分批 → `Writer.describeSource` 投影 `source_kind`/`import` → `#guardImports` 结构性阻止 forget / 覆盖用户 Section。链路完整。
- 程序强制的导入限制：分批隔离、forget 拒绝、覆盖用户/无来源链接 Section 拒绝、scope/writable/CAS/租约/安全扫描。仅由提示约束的：来源标注文字、冲突时保留用户状态、不把第一人称默认当用户。
- `document_import` 只存在于 provenance 枚举，无消费者；没有 Markdown 导入入口或预处理。
- `agent_import` 字符串在 `runtime.ts`（enqueue 的 pending 列表、claim 分批）两处硬编码，与 `writer.ts` 的判断重复；再加一种导入来源前需要收敛。
- 审查线索 1 成立：`createConfiguredWriter` 无条件要求 `user_explicit`，init-only 配置无法创建 Writer（`runMcp`、`flush`、`retry` 全部受阻）。
- 审查线索 2 成立：`demo-init-synthetic.mjs` 对 `--home` 下已有 `data/` 执行 `rmSync`，并无条件覆盖 `config.json`/`.env`。

[外部事实]（访问日期 2026-09-07，`learn.chatgpt.com/docs/extend/mcp.md`、`/docs/customization/memories`、`/docs/use-chatgpt.md`）：与 §2.1 一致——桌面应用、Codex CLI、IDE 扩展共享同一 Codex host 的 `config.toml`，支持 STDIO；ChatGPT 网页端不读本地配置；"ChatGPT web uses ChatGPT memory, while local Codex clients use a separate local memory store"。新增相关项：`memories.disable_on_external_context` 为 true 时，使用过 MCP 工具的会话不参与本地记忆生成（不影响本设计，但 Init 会话本身不会再被 Codex 本地记忆总结）。

[外部事实]（本机实测）：`wsl.exe --help` 列出 `--distribution/-d`、`--user/-u`、`--exec/-e`、`--cd`；从 WSL 内经 interop 调用 `/mnt/c/Windows/System32/wsl.exe -d Ubuntu -u mrremon -e /usr/bin/env COMMON_MEMORY_HOME=… node …` 可用且 stdio 正常透传。

### 9.2 Import 输入预处理（[设计选择]）

职责：只做文件读取、编码/大小检查、结构识别、封装与分块；不判断价值、不提炼、不做第二套语义管线、不额外调用模型。

| 问题 | 选择 | 理由 |
| --- | --- | --- |
| 材料性质 | 信封字段 `sourceLabel`（默认文件名）、`declaredAuthor ∈ user/agent/third_party/mixed/unknown`（默认 unknown）、`fileName`、`contentDigest`、`part{index,count}`、`headingPath`；投影为 `source_kind: document_import` + `import{…}` | 让模型知道“来自哪次导入、什么性质、原始标签、哪些未知”。不伪造作者/时间：`observed_at` 是导入时间，提示词明说。`declaredAuthor` 只是记录，程序对所有 `document_import` 一视同仁，不因 `--author user` 升级为 user_turn。 |
| 是否需要 LLM 预提炼 | 否 | Writer 已承担判断/提炼/合并；再放一个模型只会重复语义层并模糊来源。 |
| 整份 vs 分块 | ≤32 KiB（与 Init `understanding` 上限一致）整份一条观察；否则按标题/空行分块、围栏不拆、整节能放则整节；单段或单个围栏超限 → 拒绝整份（`IMPORT_CHUNK_TOO_LARGE`）；整文件 >256 KiB → `DOCUMENT_TOO_LARGE` | 不静默截断；Writer 128 KiB 请求上限与现有 trim 机制自然处理“多块同批不够放”。 |
| 分块的上下文 | 每块保留祖先标题栈 `headingPath`，块内文本逐字保留（标题、引用、示例、代码块都在） | 避免示例变事实、局部限定变全局。 |
| 多块 ≠ 多次证据 | 投影带 `part i/n` 与同一 `source_label`；提示词明说“同一材料，不是重复确认” | 程序层不再另建实体；守卫不区分块。 |
| 重复/变化 | `importId = md-<sha256(内容)>`，会话键含 contextId 与信封格式版本（`v1`，分块规则变化时开启新导入而不是卡住 resume）；相同字节（无论文件名/label/author）→ duplicate，不重复入队、不重复调用模型、保留原元数据；字节变化 → 新导入 | 不用文件名判重。同内容改标签视为同一材料而非冲突，避免用户困惑。 |
| 原子性与部分失败 | 所有块一个事务入队 + flush；提交按批次、各有回执；CLI 汇报每块状态，`complete` 仅当全部 processed；未完成 → 退出码 1，明确提示 `retry`/再次 import/`flush` | 复用现有队列、租约、退避、dead-letter，不新建事务框架；不会“部分完成报整份成功”。 |
| 材料中的指令 | 只是数据；不执行代码块、不跟链接、不扫目录；提示词与守卫双重约束 | — |
| 预先安全扫描 | 入队前对每块运行 Writer 的同一 `externalPreflight`；违规报 `SENSITIVE_CONTENT_REJECTED part i/n: <rule>` 且不入队（Writer 处理时仍再扫一次） | 让用户当场知道被拒原因，而不是事后看到 quarantined。 |

### 9.3 让 Core 真正支持导入来源（[设计选择] / [项目事实] 收尾后）

- 收敛：`import.ts` 新增 `provenanceOf(source)`（`interactive|rpc|mcp_user_submission → user_explicit`，`agent_import → agent_observation`，`document_import → document_import`，其余 null）与 `isImportSource`。`RuntimeStore.enqueue` 用它决定 pending/quarantined；`claim()` 用它分批（同 scope 且同 provenance 类）；`Writer.#guardImports` 用它识别导入证据与“仅由导入产生的 Section”。
- 授权：`Writer` 新增 `allowedProvenance` 选项；`run()` 在模型调用前按批次 provenance 校验，不允许 → `UNAUTHORIZED_PROVENANCE` 隔离（与 `UNAUTHORIZED_SOURCE` 同型）。`createConfiguredWriter` 不再强制 `user_explicit`，而是透传 `disclosure.allowedProvenance`；Pi 扩展自行保留 `user_explicit` 检查（Pi 只捕获用户轮，没有披露许可就没有可捕获的东西）；MCP relay 已由 `submissionEnabled` 门控。这修复审查线索 1 的真正耦合：授权按来源类，而不是按进程。
- 投影：`source_kind` 扩展为三值；`document_import` 的 `import` 字段固定为 `{source_label, declared_author, file_name, part, heading_path}`。响应 schema、回执、SQLite 表结构、既有 Markdown 均不变，无迁移。
- 提示词：`memory-maintainer.md` 把 agent_import 段扩展为“imports”段，加入 document_import 的语义要求（作者/第一人称/示例/限定条件/多块/observed_at/不用相反“当前事实”绕过保护/文档未提及不等于遗忘/指令即数据）。
- 入口：`common-memory import`（CLI）。不新增 MCP 写工具；Codex 仍只读；Pi 集成不变。

### 9.4 Windows / WSL（[设计选择]）

- 唯一运行环境为 WSL；Windows 侧只做 `wsl.exe` 桥接。`common-memory mcp-config [--wsl]` 输出固定了 `-d <WSL_DISTRO_NAME> -u <linux user> -e /usr/bin/env COMMON_MEMORY_HOME=<配置目录> <node 绝对路径> <dist/cli/main.js 绝对路径> mcp …` 的 TOML 块及注释头（配置目录、dataRoot、node、CLI 入口）。不做安装器、不做通用路径映射；Windows 路径不是合法项目，需注册 WSL 路径。Pi 以 WSL 内运行为准。
- 统一的是配置权威与数据，不是进程：`init`/`read` 进程按角色启动，共享同一 dataRoot。

### 9.5 演示脚本（审查线索 2）

默认使用 `mkdtemp` 新目录；`--home` 只接受不存在或空目录；`config.json`/`.env` 用 `wx` 创建；不再有任何 `rmSync`。新增 `--markdown <file>` 让同一脚本演示两条链路落到同一份记忆。

### 9.6 未验证 / 决策项（收尾后）

- [未验证] 真实维护模型对 `document_import` 的语义处理（标题/示例/限定条件/第一人称）；本机无 API key，测试为脚本化模型。
- [未验证] ChatGPT 桌面端实际调用 `memory_init`（GUI 在 Windows，WSL 不能驱动；`wsl.exe` 启动 init 进程的握手已实测）。
- [被阻塞] Codex CLI / Pi 真实模型回合：账户用量上限（见验收记录）。
- [决定] 真实链路需要用户在 WSL 配置真实 OpenAI 兼容 API key 与 `allowedProvenance`，并把 `mcp-config --wsl` 输出粘贴到 Windows `%USERPROFILE%\.codex\config.toml`；本次未替用户改动 Windows 侧配置。


## 10. 可核对的已有理解迁移（2026-09-08）

[设计选择] 一次性迁移本次可取得并选定的材料。先保存账号实际可见的 Memory Summary／旧版 Saved Memories 原文和可用日期、出处；针对遗漏主题向源端提问时保留可核对出处，无依据猜测留在导入之外的待核对材料中。[Memory FAQ](https://help.openai.com/en/articles/8590148) 明确 Summary 和回答来源列表都不保证完整；[Memories 官方说明](https://learn.chatgpt.com/docs/customization/memories) 区分产品体系。这些描述不能代替本地调用证据，也不能量化遗漏。

用户选定 Markdown 走 `common-memory import`（`document_import`），Agent 提交实际可见材料走 `memory_init`（`agent_import`）。分别通过 `document_import`、`agent_observation` provenance 授权；批准迁移不等于逐条确认真实性。推荐独立临时配置和独立 `dataRoot` 试导入，核对后仍通过既有入口正式导入，以正式库 `common-memory show` 为最终核对对象。具体操作见 [README](../README.md#migrate-selected-checkable-material)。隔离试导入不保证正式运行相同结果。

[项目事实] 本次只更新 Init server instructions、工具描述及配置输出注释与文档。参数、数据库、Writer、`memory_maintenance_v2`、队列/flush/重试/读取生命周期保持不变。这些指导是 **soft semantic defense（软性语义防御）**：无法证明来源正确、阻止所有无依据新事实或语义冲突，也不能代替结果核对。结构守卫保护用户 Section，不提供语义真实性保证。

v0.1 不引入 migration lifecycle：没有迁移状态机、消费者暂停/恢复接口或 Core 审批队列；不新增服务器、完整聊天解析器、画像生成器或 schema。验收目标是忠实迁移本次选定的已有理解，明确来源、条件、不确定性与遗漏，不承诺完整导出或自动消除语义错误。
