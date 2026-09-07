# Init v0.1：跨 Agent 记忆迁移与复用 — 研究、设计与计划

日期：2026-09-07。分支 `init-v0.1`（worktree），基线 HEAD `a9fc436`（main 同一提交），工作树干净。
Node v24.20.0，`@modelcontextprotocol/server` 2.0.0（协议修订 2026-07-28），Pi peer 锁定 0.84.4，
本机 Codex CLI 0.153.4，Windows 侧 ChatGPT/Codex 桌面应用 26.901.51231。

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
- 调用时能否访问既有理解：取决于运行模式。[外部事实] 本地 Codex/Work-local 使用 **本地 Codex memories**（MEMORY.md/摘要）而不是 ChatGPT 云端 Memory；Chat 模式使用云端 Memory 但不读本地 MCP 配置。因此 **“把 ChatGPT 云端 Memory 直接导入本地”在同一会话内无法同时满足“本地 STDIO + 云端 Memory”**，除非走远程 HTTPS 连接器（需隧道/公网端点，见 §2.4）。[未验证] Work-local 模式是否同时能引用云端 Memory，官方文档未明确；需用户实测并记录。
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

1. **ChatGPT 桌面版**：工具接通可行（本地 STDIO，官方支持）；“既有理解”的来源取决于模式（本地 Codex memories vs 云端 Memory）。不把“生成一段总结”当作导出全部内部记忆；Init 记录 `basis` 与 `gaps` 让来源可见。真实桌面 E2E 本会话不可执行 → 标为未验证，提供步骤。
2. **能力边界**：同一 Codex host 共享 `config.toml`，因此**不能靠宿主区分客户端**。设计为：每个 MCP 进程在启动参数上固定能力（`--capability init|read|relay`），服务端只注册对应工具；宿主侧再叠加 `enabled_tools`（Codex）与审批模式；Codex CLI 用 profile/`-c` 关闭 init 服务。任何工具参数（如客户端自报名称）都不作为身份或授权。
3. **部署要求**：STDIO 路径不新增网络端点、隧道或常驻服务。若用户坚持 Chat 模式（云端 Memory）→ 需要远程 HTTPS 连接器 + 隧道，这是新增数据外发与暴露面，**列为需要用户决定的事项**，本版不实现。

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
- `understanding`：Agent 用自己的话写的当前理解（≤32 KiB）。
- `gaps`：Agent 无法访问/不确定的部分。

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

## 6. Markdown 文件导入评估（不交付）

价值：可把已有笔记/AGENTS 风格资料一次性引入。成本：需要文件读取入口（CLI）、`document_import` 来源处理与提示词分支、与 Init 相同的重复/冲突处理。可复用性：与本次 `agent_import` 机制同构（`source` 换成 `document_import`，已在 provenance 枚举中）。结论：本版不实现；Init 机制为其铺路。不能用手动 Markdown 导入替代 ChatGPT 链路验收。

## 7. 验收与验证分层

1. 合成材料与自动化测试（vitest，fake provider）：能力分档、Init 幂等/冲突/门控、`retainedIn`、forget 守卫、读取隔离/空记忆、Pi 注入、回归。
2. MCP 协议与客户端接入：真实 stdio 子进程（测试）；真实 Codex CLI（隔离 `CODEX_HOME`，只复制 auth）开/关对照；真实 Pi 0.84.4 干净会话开/关对照。以上使用合成事实与隔离 `COMMON_MEMORY_HOME`。
3. 真实 ChatGPT 桌面版 → Core → Codex/Pi：本会话不可执行（GUI 在 Windows、无 API key）；给出步骤与记录模板，结果标注未验证。

## 8. 未验证与需要用户决定

- [未验证] ChatGPT 桌面版实际调用 `memory_init` 及其可用的“既有理解”来源；Work-local 是否能引用云端 Memory。
- [未验证] 真实维护模型对 agent_import 的语义处理质量（与仓库既有立场一致，需显式凭据）。
- [决定] 是否接受“通过远程 HTTPS 连接器 + 隧道”让 Chat 模式（云端 Memory）直接调用 Init：新增公网暴露与数据外发，本版不做。
- [决定] 真实 Writer 联调需要 OpenAI 兼容 API key（本机无）。
