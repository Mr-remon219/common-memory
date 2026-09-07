# Init v0.1 验收记录 — 2026-09-07

分支 `init-v0.1`（worktree，基线 `a9fc436`）。所有数据均为合成事实与隔离目录（`/tmp/common-memory-demo`、`/tmp/cm-codex-home`、`/tmp/cm-pi-home`），未使用真实个人资料。真实账户使用仅限本机已登录的 Codex CLI / Pi（ChatGPT OAuth），且实际被用量上限阻断（见 §3）。

合成测试事实（不在仓库源码、文档或常识中出现）：生态学学生；养一只三条腿的救助龟 Quillon；周末学 Rust；希望中文回答、英文术语加括号、不要敬称。

## 1. 合成材料与自动化测试（通过）

`node scripts/verify.mjs`：typecheck、边界检查（32 源文件）、vitest 18 文件 / 180 测试、`tsc` 构建全部通过。`npm run build && npm run test:consumer` 见 §5。

与本次改动相关的边界测试（文件 → 用例）：

| 场景 | 位置 | 结果 |
| --- | --- | --- |
| Init 门控：需 `--capability init` 且 `allowedProvenance` 含 `agent_observation`；init 进程不能 submit/read | `tests/mcp/ingress.test.ts` “init needs the launch capability…” | 通过 |
| 重复导入：同 importId 同 payload → duplicate；改 payload → `SUBMISSION_CONFLICT`；非法标签/超 32 KiB 拒绝；提交后立即可 claim（flush）；不同 client 命名空间隔离 | 同上 “init is idempotent…” | 通过 |
| 状态区分：processed+retainedIn 与 processed+空 | 同上 “status distinguishes…” | 通过 |
| 越权读取/跨项目隔离：只返回启动 workspace 对应项目；`project:B` → `CONTEXT_UNAVAILABLE`；无 `--global` 不返回 Profile；读进程无 store | 同上 “read exposes only launch contexts…” | 通过 |
| 空记忆：`empty:true`，不创建 `memory/` 目录 | 同上 “empty memory reads as empty…” | 通过 |
| 真实 stdio 子进程：read 进程工具列表仅 `memory_read`/`memory_status`、无 API key 可用、不创建 `runtime.sqlite` | `tests/mcp/protocol.test.ts` “read-only launch…” | 通过 |
| Init 端到端（合成 Responses 服务）：`memory_init` → 处理 → `retainedIn:['profile']` → Markdown 含来源标注 → 重试为 duplicate 不二次写 → 另一 read 进程读到同一内容 | 同上 “init launch imports…” | 通过 |
| Writer 投影 `source_kind`/`import` 元数据；用户轮仍为 `user_turn`；原始 JSON 信封不进入投影 | `tests/v2/writer.test.ts` “projects host-assigned source_kind…” | 通过 |
| 已有记忆冲突/清库防护：仅 import 证据的 forget → `UNAUTHORIZED_FORGET_EVIDENCE`，文件不变，job 进入 retry；用户轮证据的 forget 仍可执行 | 同上 “forget backed only by an import…” | 通过 |
| import-only 批次不能通过 retain/maintain 删除或替换用户来源 Section（三种形态）→ `UNAUTHORIZED_IMPORT_OVERWRITE`；可新增 Section 并改写自身此前导入的 Section | 同上 “an import-only batch cannot remove…”、“an import may append…” | 通过 |
| import 与用户轮分批（同 scope 也不混批） | 同上 “projects host-assigned source_kind…” | 通过 |
| 渲染定界符转义：记忆内容中的 `</common-memory>` 不能闭合数据块 | `tests/mcp/ingress.test.ts` “rendered memory cannot close…” | 通过 |
| Pi 读取：注入 global + cwd 所属且被允许的项目；未授权项目不注入；空记忆明示；未配置时不改系统提示且其他处理器仍注册 | `tests/v2/pi-integration.test.ts` 末两例 | 通过 |
| Pi 原有捕获回归 | `tests/v2/pi-integration.test.ts` 其余 13 例、`tests/mcp/protocol.test.ts` 既有用例 | 通过 |

## 2. 合成演示（本地机制，通过）

```sh
npm run build && node scripts/demo-init-synthetic.mjs --home /tmp/common-memory-demo
```

输出摘录：

```
init server tools: memory_init, memory_status
memory_init -> {"accepted":true,"duplicate":false,"state":"pending","contextId":"global"}
memory_status -> {"state":"processed","issue":null,"retainedIn":["preferences","profile"]}
--- memory/profile.md ---
# Profile

## Imported understanding
Imported from demo-agent on 2026-09-07 (basis: saved_memories; not user-verified): The user is an ecology student who keeps a rescued three-legged tortoise named Quillon. ...
```

`COMMON_MEMORY_HOME=/tmp/common-memory-demo node dist/cli/main.js show` 输出同一内容（验收 C：本地可查看）。此步的维护模型是脚本化的，只证明 Init 进程 → 队列 → Writer → 提交 → 读取 的机制，不证明真实模型如何筛选。

## 3. 真实客户端接入验证

### 3.1 Codex CLI 0.153.4（协议接入通过；模型回合被用量上限阻断）

隔离 `CODEX_HOME=/tmp/cm-codex-home`：仅复制 `auth.json`，`features.memories = false`，无 AGENTS.md，无历史会话；工作目录 `/tmp/cm-demo-project`（空目录，不含仓库文件）。配置即 README “Codex CLI (read only)” 片段，另用 `tee` 记录 Codex 发给服务的 JSON-RPC。

`codex mcp list` 显示 `common_memory` enabled。`codex exec --json --skip-git-repo-check -s read-only "我是谁？"` 期间，服务实际收到：

```
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18",...,"clientInfo":{"name":"codex-mcp-client","title":"Codex","version":"0.153.4"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"progressToken":0}}}
```

即真实 Codex CLI 按配置启动了只读进程并完成握手与工具发现。随后模型回合失败：

```
{"type":"turn.failed","error":{"message":"You've hit your usage limit. ... try again at 9:48 PM."}}
```

**因此验收 D（Codex 用记忆回答“我是谁？”）未完成**：阻断点是账户用量上限，不是链路。复现（用量恢复后；隔离目录中的 `auth.json` 副本已在本次结束时删除，需重新复制）：

```sh
cp ~/.codex/auth.json /tmp/cm-codex-home/ && chmod 600 /tmp/cm-codex-home/auth.json
cd /tmp/cm-demo-project
CODEX_HOME=/tmp/cm-codex-home codex exec --json --skip-git-repo-check -s read-only "我是谁？"          # ON
CODEX_HOME=/tmp/cm-codex-home codex exec --json --skip-git-repo-check -s read-only \
  -c mcp_servers.common_memory.enabled=false "我是谁？"                                                # OFF 对照
```

判定：ON 事件流应含 `memory_read` 的 MCP 调用且回答提到 Quillon/生态学/Rust；OFF 应表示不知道。

### 3.2 Pi 0.84.4（宿主集成通过：真实 Pi 进程 + 假模型端点；真实模型回合被同一上限阻断）

Pi 默认 provider 为 `openai-codex`（同一 ChatGPT 账户），真实运行返回 `You have hit your ChatGPT usage limit (prolite plan). Try again in ~599 min.`。

为验证宿主机制，用隔离 `PI_CODING_AGENT_DIR=/tmp/cm-pi-home` 的 `models.json` 定义指向本地假 OpenAI-completions 端点的 provider（记录请求、返回固定文本），运行真实 Pi 0.84.4：

```sh
node node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js -p --provider fake-local --model fake-model \
  --no-extensions --no-context-files --no-skills --no-prompt-templates --no-session \
  -e dist/pi-extension/index.js "我是谁？"     # ON
```

- ON：假端点收到的系统提示含 `## Common Memory` 块与 `<common-memory target="profile">…Quillon…`；用户消息为 “我是谁？”。
- OFF（不加 `-e`）：系统提示中 `Common Memory` 出现 0 次。
- 回归：两次会话的用户轮均被扩展捕获进入队列（`status` 显示 pending/claimed），写路径未受读取影响。

**验收 E 的“Pi 用真实模型回答”未完成**，阻断同为用量上限；复现：把上面命令去掉 `--provider/--model`、加 `COMMON_MEMORY_HOME=/tmp/common-memory-demo`，并对照不加 `-e`。

### 3.3 ChatGPT 桌面版（未验证）

本机桌面应用在 Windows（26.901.51231，`C:\Users\Administrator\.codex\config.toml`），WSL 无法驱动其 GUI。已验证的部分：从 Windows 侧 `wsl.exe -e /usr/bin/env COMMON_MEMORY_HOME=… node dist/cli/main.js mcp --client-id chatgpt-desktop --capability init --global` 通过 stdio 完成 `initialize`（返回 `instructions`）与 `tools/list`（仅 `memory_init`、`memory_status`）。

需用户执行的步骤：
1. 在 Windows `C:\Users\Administrator\.codex\config.toml` 追加 README “ChatGPT desktop app (init only)” 的 `wsl.exe` 片段（路径替换为实际 WSL 路径；`COMMON_MEMORY_HOME` 指向已 `common-memory config` 且 `allowedProvenance` 含 `agent_observation` 的目录）。
2. 重启桌面应用；选择 **Codex**（或可用本地 MCP 的 Work-local）模式；`/mcp` 确认 `common_memory_init` 已连接。
3. 新会话输入：“把你目前对我的长期理解导入 Common Memory。” 批准工具调用。
4. 记录：是否调用 `memory_init`；`basis` 与 `gaps` 字段内容（这揭示其“既有理解”来源是本地 Codex memories 还是别的）；`memory_status` 返回的 `state/retainedIn`。
5. 本地 `common-memory show` 核对；再用 §3.1/§3.2 命令做 Codex/Pi 读取。

已知限制：桌面 **Chat** 模式与网页端不读取本地 MCP 配置（官方文档），因此“ChatGPT 云端 Memory → 本地 Init”在本版无法直接成立；见设计文档 §2.1、§8。

## 3.4 独立审阅

一个只读审阅子 Agent 对全部改动做缺陷优先审查（主 Agent 逐条核对 `contract.ts` 后确认）：P1 —— 原守卫只拦 `forget`，import-only 批次仍可用 `retain`/`maintain` 的 `remove_section`/整段 `put_section` 覆盖用户 Section；已改为按操作判定并分批，见 §1 新增用例。P3 —— Init flush 影响已排队用户轮（已在 README 说明）、渲染未转义定界符（已修）、Pi 扩展缓存 null 配置（已修）、只读进程上 status 误报 `MEMORY_UNAVAILABLE`（改为 `STATUS_UNAVAILABLE`）、设计文档签名不一致（已修）。审阅未发现只读进程写入、工具参数扩权、schema 解析或幂等缺陷。

## 4. 平台

以上均在 WSL2/Linux 执行。Windows CI 未在本会话运行；`wsl.exe` 探测只证明 Windows→WSL 启动路径可用，不代表 Windows 原生运行。

## 5. 结论

- ChatGPT 导入 → 本地可查看 → Codex 与 Pi 复用同一份记忆：**机制已打通并有自动化与真实进程证据；端到端真实模型回合（ChatGPT 实际调用、Codex/Pi 实际作答）未完成。** 断点分别在：ChatGPT 桌面 GUI 不可在本会话操作（步骤已给）；Codex/Pi 模型回合受账户用量上限阻断（21:48 后可按 §3 复现）。
- 未验证：真实维护模型对 agent_import 的语义处理；Work-local 模式能否引用云端 Memory。
