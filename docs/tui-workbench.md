# 极简 TUI：Setup、Show、Uninstall

本文描述 v0.3.0 的 Setup、管理和卸载流程。

```sh
common-memory             # 首次 Setup；已配置则进入管理
common-memory show        # Overview / View Memory / Modify Memory
common-memory uninstall   # 移除接入或完整卸载
```

单选使用 ↑↓ / Enter，Esc 返回上一步；首页 Esc 退出。只有接入安装、移除的真正多选使用 Space。
没有 Dashboard、Settings、账单、用量、Markdown 编辑器或 Delete Memory 页面。

## 首次 Setup

```text
Model Configuration
  Provider → API Key → 实时模型列表 → Enter 保存
Integration Installation
  扫描客户端 → Space 多选 → Enter 安装
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

预置项不询问 URL 或接口类型。Custom 只询问 **Base URL → API Key → Model Name**，不发现模型。
Qwen、Kimi、Zhipu 使用上表的中国区普通 API；其他区域、Coding Plan 或 Responses-only 自定义接口
不能假设与这些入口通用。前两类可使用兼容 Chat Completions 的 Custom 入口；其他协议仍属技术配置范围。

模型列表只在用户主动进入模型选择步骤时执行一次 `GET /models`：

- 使用本次填写的 Key；无推理探测、记忆上传、余额/账单查询、后台刷新或模型列表缓存。
- 返回该目录中 Core 支持的文本模型；过滤媒体模型、异常标识及未支持的协议，不凭目录出现就宣称维护质量已验证。
- OpenCode Go 的部分模型使用 Anthropic Messages；当前 Core 不支持该协议，因此不列入可选项。
- 20 秒超时、响应上限 1 MiB；不跟随重定向、不显示服务端错误正文或 Key。
- Esc 返回；重新进入时重新获取。失败不会保存本次 Key，可以重选 Provider 或使用 Custom。
- 普通启动、`show`、Writer/Runtime、Pi、MCP 和后台任务均不发现模型。
- 使用现有网络配置及环境代理，不增加网络设置步骤；错误代理环境仍会导致明确的发现失败，不暗中绕过。

模型单选的 Enter 就是保存确认。配置、私有凭据和 Setup 中断标记使用可恢复的跨文件提交。
新向导写入 `remote.preset` 与 `apiKeySource: "private-env"`，防止继承的其他 Provider Key 替换用户刚填写的 Key。
凭据使用独立的生成标识，避免配置保存中断时旧模型读到新 Key；历史生成凭据只保存在私有 `.env`，完整卸载会清理。
旧配置未设置 `apiKeySource` 时保留进程环境优先的原行为。

`common-memory config` 是直接重进模型配置页的兼容快捷命令，不是 Settings 页面。
首次流程在保存模型后中断，下次启动从接入步骤继续，不重新扫描模型。
接入失败可重试；所有选项都取消选择则跳过，不显示虚假的“已安装接入”。

## 自动接入的真实范围

扫描和安装只发生于接入流程；不让用户找路径、复制 JSON 或安装插件包。

| 客户端 | 自动安装内容 | 当前边界 |
| --- | --- | --- |
| Pi 0.84.4 | 用户级 `settings.json` 中的 Extension wrapper | 同一 Linux/macOS/WSL 环境；其他版本不假定 API 兼容 |
| Codex CLI | 用户级只读 MCP；0.153.4 另装 Hooks 和显式 refresh skill | 其他版本仅读取，不宣称自动会话维护 |
| ChatGPT Desktop | 本地 Work / Codex 的用户级只读 MCP | 不是普通 Chat；不自动捕获 Desktop 会话 |

路径来自 PATH、标准用户目录、`CODEX_HOME` 和 `PI_CODING_AGENT_DIR`。
macOS 检查 ChatGPT.app；WSL 通过只读 Windows Appx 探测确认桌面程序和用户目录，写入固定 WSL 启动配置。
**不会只因存在 WSL 就推断 Windows Desktop 已安装或使用 WSL agent。**

安装后的客户端需要重启/重新加载以读取配置。Hooks 仍须宿主信任；安装器不设置信任凭据，不改审批或沙箱策略，
也不覆盖显式禁用 Hooks 的设置。已安装 ≠ 正在运行、已获信任或真实宿主连接验收通过。

安全策略：

- `.installation/state.json` 记录精确文件、TOML 块和 JSON 列表项的归属。
- 同目录的 Codex/Desktop 共享 MCP 资源；移除其中一个不破坏另一个。
- 保留其他配置和 TOML 注释；拒绝接管手动同名项、重复 Pi 加载和已被修改的归属文件。
- 所选客户端先全部预检，再跨文件提交；失败或中断可恢复。外部并发修改发生冲突时停下，不强行覆盖。
- 拒绝链接、特殊文件、不安全路径以及冲突的 native/WSL 配置。
- 未管理的旧版接入不会自动接管；这类迁移仍需另行处理，不报安装成功。

## `common-memory show`

主菜单只有 **Overview / View Memory / Modify Memory / Exit**。

### Overview

显示 Application、配置和 Memory 路径、整个数据目录的逻辑字节大小、Provider/Model、按需运行状态，以及安装记录与实际文件是否一致。
不查询账单、不探测模型、不把 PATH 存在当成已连接，也不启动 Writer 或创建 Memory SQLite。
这里的“已安装”仅表示归属文件存在且匹配，不等于客户端在线。

### View Memory

只读浏览获授权的 Profile、Preferences 和项目 Markdown，按终端高度分页并转义控制字符。
无内容时显示空状态。项目权限不会因浏览而扩大，不提供 Markdown 编辑器。

### Modify Memory

输入自然语言，例如“我现在用 Linux，不再用 Windows”或“忘记我以前的工作地点”。
当前 TUI 面向个人记忆；后端接受显式注册且获授权的项目目标，TUI 不额外增加项目设置页。

提交前显示披露提醒，并检查权限、敏感信息和长度；随后作为真实 `interactive` 用户表达进入原 Writer/Core。
不直接写 Markdown，不新建维护协议，也不扩大权限。Writer 处理完不一定产生改动，忽略不能报“修改成功”。
等待、退避、失败、隔离和取消都有独立反馈。60 秒等待上限或提交后取消不撤回持久请求；先检查状态，勿重复提交。

非 TTY 的 `show` 保持纯文本读取；`show --plain` 强制文本输出。自动化和协议命令继续保留，详见 [使用指南](usage.md)。

## `common-memory uninstall`

```text
Remove integrations
Remove Common Memory completely
```

- **Remove integrations**：Space 多选；仅移除本安装器归属的条目，保留程序、配置和全部 Memory Data。
- **完整卸载**：确认已关闭客户端和后台任务；移除受管理接入、当前确切全局 npm 包和相关配置/密钥。
  不停止其他软件、不卸载 Node/Pi，不猜测删除源码、npx、本地安装或其他 Node 的全局包。
- **Memory Data 单独确认，默认保留**：保留整个 `dataRoot`，包括 Markdown、持久 SQLite、项目注册和恢复资料，
  而非只保留 `memory/`。小型安装记录保留自定义数据位置，供重装使用，不含 API Key。
- 明确确认删除时才删除当前数据目录；共享/重叠目录、链接、特殊文件和活动 Writer 租约会阻止删除。
- 未管理的旧接入会阻止包删除，避免留下失效 Hooks；npm 失败时保留配置和数据，并明确报告已经移除的接入。
- 私有 `.env` 中无关变量保留。不递归删除整个用户目录或配置 Home。

## 验证范围

单元/合成测试覆盖选择、取消、重复发现、无后台扫描、协议过滤、凭据来源、归属共享、冲突恢复、分离卸载和数据保护。
打包消费测试验证实际 wrapper 加载、客户端文件安装/移除，并在隔离全局 npm prefix 中执行真实自卸载。
Linux PTY 检查真实键盘与终端恢复；这些证据不等于 Windows/macOS Desktop UI、Hook 信任或真实 Provider 语义验收。

参考官方约束：[Codex / Work 配置](https://learn.chatgpt.com/docs/config-file/config-basic)、
[Hooks](https://learn.chatgpt.com/docs/hooks)、[OpenCode Go](https://opencode.ai/docs/go/)。
核心权限与会话边界见 [架构](03-target-architecture.md) 和 [会话接入](session-integration.md)。
