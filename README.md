# Common Memory

[![CI](https://github.com/Mr-remon219/common-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/Mr-remon219/common-memory/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/common-memory-core)](https://www.npmjs.com/package/common-memory-core)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**让不同 AI 助手使用同一份由你掌握的长期记忆。**

Common Memory 将背景、偏好和项目上下文保存在本机 Markdown 中，供已接入的助手按授权读取。
需要更新记忆时，由你配置的模型提出维护决定，再由本地程序校验并写入。

- **支持接入**：Pi、Codex CLI、ChatGPT Desktop 的本地 Work，以及其他本地 stdio MCP 宿主。
- **不支持**：ChatGPT 普通 Chat、网页版或网页版 Plugins；没有 HTTP MCP 服务。
- **不必常开管理界面**：完成接入后，日常直接使用助手。`common-memory` 是配置和管理入口，不是每次聊天前都要手动启动的服务。

**当前版本：v0.3.9** · npm 包名：`common-memory-core` · 命令：`common-memory`。
这是早期版本；测试通过不代表所有真实客户端交互或模型的记忆判断都已验证。

## 1. 安装

需要 **Node.js 22.19+（22.x）或 24+**，以及 npm。先用 `node --version` 检查版本；
没有 Node 时请先[安装 Node.js](https://nodejs.org/en/download)。

| 系统 | 在哪里安装和运行 |
| --- | --- |
| Linux / macOS | 本机终端 |
| Windows | **WSL 终端**；Windows 桌面助手通过生成的桥接调用 WSL 中的 Common Memory |

```sh
npm install -g common-memory-core@0.3.9
common-memory
```

无需克隆仓库、手动构建或先启动 Pi。安装命令不会安装 Node 或 WSL。
Windows 用户不要在原生 PowerShell 中另装一份 Core。遇到全局安装权限问题，建议使用用户级 Node 版本管理器，不建议 `sudo npm install`。

本版有必需的 Pi peer 依赖，仅使用 CLI/MCP 也会安装该依赖树，但不会因此自动启动或配置 Pi。

## 2. 第一次配置

界面中用 **↑/↓ 移动、Enter 确认、Space 勾选、Esc 返回**。

### 第一步：配置维护记忆的模型

首次运行按顺序填写：

```text
Provider → Base URL → API Key → Model → Enter 保存
```

1. 选择你的模型服务商。预置 Provider 提供默认 Base URL，通常直接使用该地址。
2. 填写该服务商的 **API Key**，输入不会回显。助手自身的登录或订阅不会自动成为 Common Memory 的模型凭据。
3. 预置 Provider 会获取模型列表，选中模型后按 Enter 保存。**Custom** 则手动填写模型名，不获取列表，使用 Chat Completions 接口。

**API Key 只能在 TUI 中配置并保存到私有 `.env`。所有运行入口都只读取这份凭据，
包括旧配置；终端或助手进程中的同名 API Key 环境变量不会覆盖它。**

如果获取模型列表失败，本次输入的 Key **尚未保存**。网络排查方法见文末常见问题。

### 第二步：选择要接入的助手

在 **Agent Integration** 中勾选 Pi、Codex 或 ChatGPT，按 Enter 应用。
也可以先不接入任何助手，完成配置后再添加。

- **Pi**：安装扩展，在同一 Linux/macOS/WSL 环境使用。
- **Codex CLI**：安装只读 MCP；会话捕获要求 Codex **0.153.4 或更高的正式三段数字版本**。未知会话格式会拒绝处理，不猜测内容。
- **ChatGPT Desktop**：接入本地 **Work**；Windows 下从 WSL 配置桌面桥接。不是普通 Chat。
- **可选 AI 理解导入**：Codex / Desktop Work 可额外勾选 `memory_init`，默认关闭。首次开启需确认将 AI 整理材料交给维护模型的授权。

安装后会检查只读 MCP 能否启动、是否提供预期工具，**不会调用模型或写入记忆**。
安装成功不等于当前助手已加载配置；Hooks 仍需宿主信任，工具调用仍遵守宿主审批。

### 第三步：检查网络和模型连接

完成初始化后，进入 **Model & Configuration**：

1. 在 **Current Configuration** 核对模型、API、配置目录和网络模式。
2. 需要代理或额外 CA 时，进入 **Network Configuration** 配置。
3. 选择 **Test Connection**。

| 网络选项 | 含义 |
| --- | --- |
| 正常系统网络路由（默认） | 不使用应用代理变量；系统路由、VPN/TUN 仍然生效 |
| 跟随环境代理 | 使用启动进程的代理变量；终端和桌面助手继承的环境可能不同 |
| 指定代理地址 | 显式保存代理设置，适合让多个助手使用同一条模型访问路线 |

代理地址必须从 **运行 Common Memory 的环境**可达。Windows 代理对 WSL 是否可达取决于你的网络设置，
不要直接照抄别人的 `127.0.0.1` 或端口。网络代理设置与模型 Key 的来源是两回事。

连接测试只发送少量合成内容，不读取或写入记忆。**测试通过说明这次模型请求成功，不证明完整导入一定成功。**

### 第四步：重启助手，确认实际接入

**首次安装、升级，或修改模型、Key、网络后，都应退出并重新启动使用 Common Memory 的助手及其 MCP 进程。**

仅新建聊天、关闭管理 TUI 或对助手说“重试”，不保证旧后台进程退出。
旧进程可能仍持有启动时的代码、Key 和网络配置，不能靠更新磁盘文件刷新。

重启后，在支持的宿主中用 `/mcp` 或其工具管理页面确认接入。Pi 使用扩展提供的原生工具。
可以让助手：

> 请使用 `memory_read` 查看 Common Memory 中已获授权的个人记忆。没有内容就说明为空，不要推测。

首次读取为空是正常的。下一节说明如何产生和检查记忆。

## 3. 日常怎么用

配置完成后，**正常打开已接入的助手即可，不需要每次运行 `common-memory`**。
需要管理时再打开它：

| 菜单 | 用途 |
| --- | --- |
| **Agent Integration** | 添加或移除助手，设置可选 AI 理解导入 |
| **Memory Control → Search / View Memory** | 查看授权记忆，按关键词查找当前文档；不调用模型 |
| **Memory Control → Adjust Memory** | 用自然语言新增、纠正或删除记忆 |
| **Adjust Memory → Processing Status** | 查看已提交请求，继续处理或重试失败任务 |
| **Model & Configuration** | 查看配置、更换模型/Key、设置网络、测试连接、卸载 |

### 自动维护对话中的长期信息

Pi / Codex / Desktop Work 的会话接入按 **每 10 次已完成交互**封批处理，正常真实退出时交接不足 10 次的尾批。
异常杀进程或断电不保证正常退出事件已交付；已持久保存的队列仍保留。

**不是每句话都会立即写入，也不是保存完整聊天记录。** 模型会判断是否值得保留，助手和工具内容不能冒充你的声明。
默认只授权个人记忆和用户表达，项目及导入材料需要另行显式授权。

### 主动调整一条记忆

在 **Adjust Memory** 中描述需求，例如：

> 以后回答我的问题，优先用中文，代码中的技术名称保留英文。

> 删除关于我使用某个旧工具的偏好。

提交后查看处理结果，再到 **Search / View Memory** 核实。提交后取消等待不会撤销持久请求；
不要因为没有立即看到变化，就重复提交相同内容。

### 从其他助手导入已有理解

先在 **Agent Integration** 开启该宿主的可选导入，重启后确认 `memory_init` 可用，再让助手：

> 请把你当前可见的、关于我的长期背景和偏好整理后，通过 `memory_init` 提交到 Common Memory。
> 保留来源和不确定性，不推测不可见的历史。提交后检查 `memory_status`，再用 `memory_read` 核实结果。

这只导入助手**当前可见的理解**，不会自动读取该产品的全部历史聊天或云端记忆。
导入保留 AI 来源，不等同于你逐条确认，也不能单独作为删除用户来源记忆的依据。

本地 Markdown 也可导入，但需先显式授权 `document_import`，参见[导入说明](docs/usage.md#importing-a-markdown-file)：

```sh
common-memory import notes.md --author user
```

## 4. 数据、隐私与备份

默认配置目录为 `~/.common-memory`；使用 `COMMON_MEMORY_HOME` 时，所有助手应指向同一个配置目录。
**Current Configuration** 会显示实际路径。

| 默认位置 | 内容 |
| --- | --- |
| `~/.common-memory/config.json` | 模型、网络、授权和存储设置，不含明文 Key |
| `~/.common-memory/.env` | TUI 保存的私有凭据与相关网络设置 |
| `~/.common-memory/data/memory/` | 长期记忆 Markdown，可直接查看和编辑 |
| `~/.common-memory/data/runtime.sqlite` | 持久队列、任务状态、租约和来源链接 |

- **本地存储不等于离线运行**：维护记忆时，获授权的材料会发送到你配置的模型服务商。
- 只读记忆不需要模型 Key，也不会打开运行时 SQLite。
- Markdown 和 SQLite 是本地明文；不要把密码或 Key 放进记忆、提交到 Git，敏感扫描并非万无一失。
- 备份前停止所有写端，备份**配置目录和完整 dataRoot**，包括 SQLite、现存 sidecar、回执等文件。不要只备份 `memory/`。
- **不要删除 SQLite“重建缓存”**：它不是可重建的索引。忘记当前记忆也不等于删除助手历史聊天或外部备份。

详见[安全说明](SECURITY.md)与[备份、回退及卸载](docs/releasing.md#升级备份和卸载)。

## 5. 升级与卸载

升级步骤：

1. 退出管理 TUI，停止已接入的助手、MCP 和脱离宿主运行的 `session-drain`，备份完整数据。
2. 在原来安装 Common Memory 的环境中执行：

   ```sh
   npm install -g common-memory-core@0.3.9
   common-memory --version
   ```

3. 运行 `common-memory` 核对配置。若升级说明要求重新应用接入，或 Node/安装路径改变，在 **Agent Integration** 保留所需选择并重新应用。
4. 重新启动助手和 MCP，确认工具可见，再检查失败任务是否需要显式重试。

**v0.3.9 特别提醒**：不再使用宿主环境中的模型 Key。原来仅靠终端变量配置的用户，需要在 TUI 中保存有效 Key。
多个版本不要同时写同一份存储。详细迁移要求见[发布说明](docs/releasing.md)。

完整卸载入口为 **Model & Configuration → Uninstall Common Memory**，按界面确认接入和数据的处理方式。
单独执行 `npm uninstall -g common-memory-core` 只卸载程序，不会自动清除记忆或所有宿主注册。

## 更多文档与开发

- [完整使用指南与命令](docs/usage.md#commands) · [TUI 菜单说明](docs/tui-workbench.md)
- [会话接入及验收边界](docs/session-integration.md) · [架构](docs/03-target-architecture.md)
- [发布与验证](docs/releasing.md) · [变更记录](CHANGELOG.md) · [文档目录](docs/00-index.md)
- [Memory Benchmark](https://github.com/Mr-remon219/memory-benchmark)：独立 Writer 评测项目

源码开发同样需要受支持的 Node 版本：

```sh
git clone https://github.com/Mr-remon219/common-memory.git
cd common-memory
npm ci
npm run verify
npm run test:consumer
```

Linux/macOS CI 验证 Core 与安装包；Windows CI 验证原生桥接，真实 WSL 另行验收。
这些检查不代替真实 Desktop UI 信任确认或模型语义质量评测。

**License：** [MIT](LICENSE) © 2026 Mr-remon219 and contributors.

## 常见问题与解决方法

### 每次使用都要手动启动 Common Memory 吗？

不用。完成配置和接入后，扩展、Hooks 或 MCP 由助手触发，维护任务按需运行。
`common-memory` 的管理界面可以关闭。但未接入的助手不会因为安装了 npm 包就自动获得记忆。

### “模型发现失败”，刚输入的 Key 保存了吗？

**没有。** 预置 Provider 要在获取列表并选中模型后才保存配置和 Key。
“模型发现失败”的泛化提示不能单独证明 Key 错了，也可能是网络、超时或响应格式问题。

- 已完成初始化：先到 **Network Configuration** 检查路线，再重新进入模型配置。
- 首次配置就卡住：可以先选 **Custom**，手动填写你确认正确的兼容 Chat Completions 地址、Key 和模型名，完成保存（可暂不接入助手），再设置网络。需要预置 Provider 时随后重新选择。
- Custom 只是跳过模型列表发现，**不会绕过认证或修好网络**。

### 界面只显示“连接测试未通过”，怎么看具体原因？

v0.3.9 的 TUI 未展示完整连接诊断。请在相同配置目录对应的终端执行：

```sh
common-memory --version
common-memory status
common-memory network-test
```

`network-test` 只测试**已保存**的配置，不会测试上一次未保存的 Key，也不会写入记忆。
提供错误码、`diagnostic` 和版本即可；不要发送 `.env` 或完整 Key。

| 诊断 | 含义与处理 |
| --- | --- |
| `AUTHENTICATION` / HTTP 401、403 | 服务端拒绝认证或访问。核对服务商、地址和 Key，在 **Change Model / Provider** 重新配置；反复改网络不会替换 Key |
| `PROXY_AUTHENTICATION` / 407 | 代理认证失败，不是模型 Key 认证失败；检查代理凭据 |
| `UNAVAILABLE` / `network_error` | 网络连接或响应传输失败。核对当前路线、代理是否可达、WSL 与桌面环境差异；不能仅凭该码断定具体故障点 |
| `TIMEOUT` | 请求未在期限内完成。检查网络和服务状态；HTTP 200 后超时也不代表收到完整模型结果 |
| `RATE_LIMITED` / 429 | 服务端限流；检查对应账户限制和返回信息，等待退避，不要连续创建新导入 |
| `INVALID_RESPONSE` | 返回内容不满足接口或输出契约。核对所选 API、模型和服务商兼容性，不要把它当作写入成功 |

### `API Key: configured (not tested)` 为什么还会 401？

它只表示私有 `.env` 中有非空 Key，**不代表服务商接受这个 Key**。保存网络设置也不会更新 Key。
在 **Change Model / Provider** 中重新填写有效凭据，完成保存、测试连接，再重启助手/MCP。

### 测试通过了，助手还是用旧 Key、报旧错误或重复重试？

先排除**旧进程没有退出**。运行中的 MCP/Writer 固定了启动时的配置和凭据；升级软件或保存新设置不会热更新它们。

1. 完全退出相关助手及其 MCP 后台进程；只新建聊天或关闭 TUI 不一定有效。
2. 确认没有旧 `session-drain` 消费者仍在运行，再重新打开助手。
3. 核对新进程使用相同的 `COMMON_MEMORY_HOME`、安装路径和 Node 环境。
4. 对已有失败任务执行显式重试，不要另建一批相同导入。

新进程下的小型连接测试通过，仍不能保证更大请求不会超时；继续以任务状态和实际记忆为准。

### `accepted: true` 是已经记住了吗？`dead` 怎么恢复？

不是。请求接受、模型处理和记忆写入是不同阶段：

| 字段 / 状态 | 含义 |
| --- | --- |
| `accepted: true` | 请求已接收，不代表已写入 |
| `duplicate: true` | 相同请求已提交，返回已有状态；不会自动复活失败任务 |
| `pending` / `claimed` / `running` | 等待或处理中，不代表成功 |
| `retry` | 等待自动退避重试，按 `retryAt` 查看时间 |
| `dead` | 自动处理已停止，输入保留，需修复原因后显式重试 |
| `quarantined` | 材料被隔离，检查授权、敏感内容、容量或格式；不能靠普通重试绕过 |
| `processed` | 已处理，但模型可能选择忽略；通过 `retainedIn` 和重新读取记忆核实留存 |

**首选界面恢复**：修复配置并重启旧进程后，进入
**Memory Control → Adjust Memory → Processing Status → 重试失败任务**。

也可使用命令，`JOB_ID` 替换为状态中的实际任务 ID：

```sh
common-memory retry JOB_ID
common-memory flush
common-memory show --plain
```

`retry` 重新排队，`flush` 处理可执行队列；它们不是删除数据或重新导入。
v0.3.9 的永久服务错误（如 401/403）首次失败即停止自动重试；瞬时网络错误仍按退避和次数上限处理。
任务处于 `running` 时显示的诊断可能来自之前一次失败，不一定是当前尝试的最终结果。

### 聊了几句却没有记忆，或者新记忆没有自动出现在当前对话里？

- 自动会话维护通常在 10 次已完成交互后封批，正常退出再交接尾批；未完成的会话不会因 `flush` 就强行封批。
- 模型可能判断没有需要长期保留的内容，检查任务状态与 **Search / View Memory**。
- 助手已有的自动注入快照不保证实时更新。用 `memory_read` 主动读取最新授权记忆；Codex/Work 的显式刷新机制见[会话说明](docs/session-integration.md)。
- 异常退出后如有已持久保存但尚未处理的会话交接，可在修复配置后执行 `common-memory session-drain`，不要删除运行数据库。

### 显示“已安装”，为什么助手没有工具？

“已安装”描述接入文件，不代表助手当前在线、已加载新配置或已信任 Hooks。
确认使用受支持的本地助手/Work 模式，重启后检查 `/mcp` 或工具管理页；Pi 检查扩展加载。
同时排查当前 profile/项目配置覆盖、不同配置目录或安装路径。

只有 `memory_read`、没有 `memory_init` 时，检查是否在 **Agent Integration** 显式开启了可选 AI 理解导入并完成授权。
普通 Chat 或网页版不属于本地接入范围，重启也不会使它们获得这些工具。

### 地址明明是 DeepSeek，为什么显示 `Provider: Custom`？

旧配置未记录预置身份时，界面按预置地址匹配名称。比如 `https://api.deepseek.com` 与预置的
`https://api.deepseek.com/v1` 不完全一致，可能显示 Custom。
这个标签本身不能证明接口不可用或解释 401；实际请求取决于 **Base URL、API 和 Model**。
需要按预置流程配置时，在 **Change Model / Provider** 重新选择 DeepSeek 并保存。
