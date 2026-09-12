# Common Memory 统一 TUI

本文描述当前源码的统一管理流程。日常操作只需要一个入口：

```sh
common-memory
```

首次运行进入初始化；完成以后再次运行直接进入主 TUI。主界面分为
**Agent Integration / Memory Control / Model & Configuration** 三个栏目。
单选使用 ↑↓ / Enter，Esc 返回上一步；首页 Esc 退出。Agent 列表使用 Space 勾选、Enter 应用。

## 首次 Setup

```text
Model Configuration
  Provider → Base URL → API Key → Model → Enter 保存
Agent Integration
  扫描可接入状态 → Space 多选 → Enter 自动安装
Done → 退出
```

Provider 单选：

| Provider | 内置 Base URL | 请求协议 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | Chat Completions |
| Qwen / Alibaba Bailian | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Chat Completions |
| OpenAI | `https://api.openai.com/v1` | Responses |
| Zhipu | `https://open.bigmodel.cn/api/paas/v4` | Chat Completions |
| OpenCode Go | `https://opencode.ai/zen/go/v1` | 按支持的模型家族选择 |
| Kimi | `https://api.moonshot.cn/v1` | Chat Completions |
| Custom | 用户输入 | Chat Completions |

所有 Provider 都按 **Base URL → API Key → Model** 配置。预置项填入默认 URL，用户可以确认或修改；
模型目录请求使用本次填写的地址。API Key 隐藏输入。Custom 手动填写 **Model Name**，不发现模型。
Qwen、Kimi、Zhipu 使用上表的中国区普通 API；其他区域、Coding Plan 或 Responses-only 自定义接口
不能假设与这些入口通用。前两类可使用兼容 Chat Completions 的 Custom 入口；其他协议仍属技术配置范围。

模型列表只在用户主动进入模型选择步骤时执行一次 `GET /models`：

- 使用本次填写的 Key；无推理探测、记忆上传、余额/账单查询、后台刷新或模型列表缓存。
- 返回该目录中 Core 支持的文本模型；过滤媒体模型、异常标识及未支持的协议，不凭目录出现就宣称维护质量已验证。
- OpenCode Go 的部分模型使用 Anthropic Messages；当前 Core 不支持该协议，因此不列入可选项。
- 20 秒超时、响应上限 1 MiB；不跟随重定向、不显示服务端错误正文或 Key。
- Esc 返回；重新进入时重新获取。失败不会保存本次 Key，可以重选 Provider 或使用 Custom。
- 已完成初始化后的普通启动、配置查看、Writer/Runtime、Pi、MCP 和后台任务均不发现模型。
- 使用现有网络配置及环境代理，不增加网络设置步骤；错误代理环境仍会导致明确的发现失败，不暗中绕过。

模型单选的 Enter 就是保存确认。配置、私有凭据和 Setup 中断标记使用可恢复的跨文件提交。
新向导写入 `remote.preset` 与 `apiKeySource: "private-env"`，防止继承的其他 Provider Key 替换用户刚填写的 Key。
凭据使用独立的生成标识，避免配置保存中断时旧模型读到新 Key；历史生成凭据只保存在私有 `.env`，完整卸载会清理。
旧配置未设置 `apiKeySource` 时保留进程环境优先的原行为。

后续可从 **Model & Configuration → Change Model / Provider** 重新进入同一模型配置流程。
`common-memory config` 仅保留为兼容快捷命令。
首次流程在保存模型后中断，下次启动从接入步骤继续，不重新扫描模型。
接入失败可重试；首次未选择任何 Agent 时可完成初始化，不显示虚假的“已安装接入”。

## Agent Integration

首次初始化与日常管理共用同一接入选择流程。列表显示 **Pi / Codex / ChatGPT**，并说明当前
可接入性、受管理安装状态与限制。未检测到或不支持的客户端不会伪装为可以安装。

日常管理以已有受管理接入作为初始勾选状态：

- **Space**：选择 / 取消选择，尚未写入安装配置。
- **Enter**：将最终选择与原状态比较；新增项自动安装，取消项自动移除，继续勾选的项核对并补齐当前受管理资源（包括只读安装升级）。
- **Esc**：返回，不应用本次选择。

例如原来 Pi、Codex 已勾选，改为 Pi、ChatGPT 已勾选后确认，会保留 Pi、移除 Codex 接入、
安装 ChatGPT 接入。日常列表无需分别选择“安装”和“卸载”；取消全部勾选会移除受管理接入，
保留 Common Memory、配置及全部 Memory Data。未由本安装器管理的配置不会被自动接管或删除。

## 自动接入的真实范围

扫描和安装只发生于接入流程；不让用户找路径、复制 JSON 或安装插件包。

| 客户端 | 自动安装内容 | 当前边界 |
| --- | --- | --- |
| Pi（不限制版本号） | 用户级 `settings.json` 中的 Extension wrapper | 同一 Linux/macOS/WSL 环境；发现可执行文件即可选择，事件兼容性不等于所有历史版本均已验证 |
| Codex CLI | 用户级只读 MCP；>=0.153.4 数字版本另装 Hooks 和显式 refresh skill | 无版本上限；未知结构拒绝，不猜测交付 |
| ChatGPT | Desktop 本地 Work 的 Hooks、显式 refresh skill、原有 read MCP；Windows 附 WSL bridge | 自动收集仅限本地 Work；不是普通 Chat 或网页版；仍需宿主信任与披露授权 |

路径来自 PATH、标准用户目录、`CODEX_HOME` 和 `PI_CODING_AGENT_DIR`。
macOS 检查 `/Applications/ChatGPT.app` 和 `~/Applications/ChatGPT.app` 目录；WSL 通过只读 PowerShell 探测 Windows Appx 和开始菜单应用，确认桌面程序与 Windows 用户目录后写入固定 WSL 启动配置。
Windows 优先检查 `*ChatGPT*` 包，未命中时用 `Get-StartApps` 查显示名 `ChatGPT`，兼容包名仍为 `OpenAI.Codex` 的桌面版；只有 Codex 而没有 ChatGPT 显示名不会被当成 ChatGPT。
**不会只因存在 WSL 就推断 Windows Desktop 已安装或使用 WSL agent。**
探测依据：[Microsoft Get-StartApps](https://learn.microsoft.com/en-us/powershell/module/startlayout/get-startapps?view=windowsserver2025-ps)
返回当前用户已安装应用的显示名与 AppID；[Pi 包规范](https://pi.dev/docs/latest/packages) 建议宿主 peer 使用 `*`。
这些是发现与包安装依据，不是所有宿主版本的运行时兼容性保证。

同一宿主配置根中的 Codex / ChatGPT 共享一套捕获和刷新资源；内部 client=codex 表示宿主协议，
不推断前端身份。自动安装不增加导入能力；移除一方保留另一方所需资源。
已有受管理只读接入重新按 Enter 即可升级；外部修改不会被覆盖。

安装后的客户端需要重启/重新加载以读取配置。Hooks 仍须宿主信任；安装器不设置信任凭据，不改审批或沙箱策略，
也不覆盖显式禁用 Hooks 的设置。已安装 ≠ 正在运行、已获信任或真实宿主连接验收通过。

安全策略：

- `.installation/state.json` 记录精确文件、TOML 块和 JSON 列表项的归属。
- 同目录的 Codex/Desktop 共享 MCP 资源；移除其中一个不破坏另一个。
- 保留其他配置和 TOML 注释；拒绝接管手动同名项、重复 Pi 加载和已被修改的归属文件。
- 所选客户端先全部预检，再跨文件提交；失败或中断可恢复。外部并发修改发生冲突时停下，不强行覆盖。
- 拒绝链接、特殊文件、不安全路径以及冲突的 native/WSL 配置。
- 未管理的旧版接入不会自动接管；这类迁移仍需另行处理，不报安装成功。

## Memory Control

### Search / View Memory

只读浏览获授权的 Profile、Preferences 和已注册项目的 Markdown，按终端高度分页并转义控制字符。
输入关键词可在获授权的当前文档中进行本地文字匹配，再打开匹配文档。无内容或无匹配时显示空状态。
查找直接读取 canonical Markdown，不调用模型、不建立索引、不提供语义检索或相关性排序。
项目权限不会因查找或浏览而扩大；不提供 Markdown 编辑器。

### Adjust Memory

用户直接输入自然语言，例如：

- “把关于 XX 的记忆删掉。”
- “以后 XX 应该改成 XX。”
- “把这个偏好提升为全局偏好。”

可以调整个人记忆；有已注册且获授权读写的项目时，也可先选择项目作为请求范围。
项目偏好提升为全局偏好仍由原维护规则判断，要求相应的读取与写入授权；选择项目不扩大权限。

提交前显示披露提醒，并检查权限、敏感信息和长度；随后作为真实 `interactive` 用户表达进入原 Writer/Core。
模型理解请求，Core 校验并提交记忆文件。不直接写 Markdown，不新建维护协议。
Writer 处理完不一定产生改动，忽略不能报“修改成功”。等待、退避、失败、隔离和取消都有独立反馈。
60 秒等待上限或提交后取消不撤回持久请求；不要重复提交相同请求。

尚未完成的请求可在 **Memory Control → Adjust Memory → Processing Status** 查看状态、
继续处理或重试失败任务，无需切换到其他命令。
继续处理遵守原有退避和租约规则；隔离的材料不会自动当作成功处理，也不会绕过授权。

## Model & Configuration

### Current Configuration

查看 Provider、Model、Base URL、API Key 状态、请求协议和网络路由，以及当前完整配置。
同时显示应用、配置和 Memory 路径、整个数据目录的逻辑字节大小，以及受管理接入文件是否一致。
API Key 与代理凭据不显示明文；配置中的凭据引用显示为变量名或状态。
页面不查询账单、不探测模型、不启动 Writer、不创建或打开 Memory SQLite。
运行状态表示按需处理；安装记录不等于客户端在线或 Hooks 已获信任。

### Change Model / Provider

重用首次初始化的 **Provider → Base URL → API Key → Model** 流程；保存完成后返回管理界面。
可以确认预置 URL 或修改地址，重新填写隐藏的 API Key，再选择具体模型。
模型配置不会重新执行首次 Agent 安装。配置更新后，正在运行的助手需重启才能使用新配置。

该栏目也提供网络设置与显式模型连接测试。网络设置保存不发送请求；连接测试只发送小型合成请求，
不读取记忆、不打开 SQLite，也不证明真实 Writer 已完成记忆提交。

### 完整卸载

从 **Model & Configuration** 进入完整卸载。单个 Agent 的移除仍在 **Agent Integration** 中取消勾选完成。

- 确认已关闭客户端和后台任务后，移除受管理接入、当前确切全局 npm 包和相关配置 / 密钥。
  不停止其他软件、不卸载 Node/Pi，不猜测删除源码、npx、本地安装或其他 Node 的全局包。
- **Memory Data 单独确认，默认保留**：保留整个 `dataRoot`，包括 Markdown、持久 SQLite、项目注册和恢复资料，
  而非只保留 `memory/`。小型安装记录保留自定义数据位置，供重装使用，不含 API Key。
- 明确确认删除时才删除当前数据目录；共享 / 重叠目录、链接、特殊文件和活动 Writer 租约会阻止删除。
- 未管理的旧接入会阻止包删除，避免留下失效 Hooks；npm 失败时保留配置和数据，并明确报告已经移除的接入。
- 私有 `.env` 中无关变量保留。不递归删除整个用户目录或配置 Home。

## 兼容与非交互使用

TUI 要求 stdin 和 stdout 都是终端；无参数非 TTY 调用显示入口说明，不等待输入。
既有 `show`、`config`、`config --network`、`uninstall` 保留为兼容快捷入口。
非 TTY 的 `show` 保持纯文本读取；`show --plain` 强制文本输出。
自动化和 MCP / Hooks 协议命令继续保留，详见 [使用指南](usage.md#commands)。
日常接入、记忆和模型管理无需使用这些子命令。

## 验证范围

单元 / 合成测试覆盖统一入口、配置步骤、接入选择差异、取消、本地文字匹配、授权浏览、请求状态恢复、
无后台模型扫描、协议过滤、凭据来源、归属共享、冲突恢复和数据保护。
打包消费测试验证实际 wrapper 加载、客户端文件安装/移除，并在隔离全局 npm prefix 中执行真实自卸载。
Linux PTY 检查真实键盘与终端恢复；这些证据不等于 Windows/macOS Desktop UI、Hook 信任或真实 Provider 语义验收。

参考官方约束：[Codex / Work 配置](https://learn.chatgpt.com/docs/config-file/config-basic)、
[Hooks](https://learn.chatgpt.com/docs/hooks)、[OpenCode Go](https://opencode.ai/docs/go/)。
核心权限与会话边界见 [架构](03-target-architecture.md) 和 [会话接入](session-integration.md)。
