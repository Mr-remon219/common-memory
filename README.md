# Common Memory

[![CI](https://github.com/Mr-remon219/common-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/Mr-remon219/common-memory/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/common-memory-core)](https://www.npmjs.com/package/common-memory-core)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**让不同 AI 助手使用同一份由你掌握的长期记忆。**

Common Memory 把长期内容保存在本机的 Markdown 中，通过 Pi 扩展、Codex / ChatGPT Work
会话接入和本地 MCP，让助手读取获授权的个人偏好、背景与项目上下文。模型提出维护决定，
本地 Core 校验后写入；你可以直接查看和编辑文件。

**v0.3.2** · npm 包名 `common-memory-core` · 命令 `common-memory` · MIT 许可证。
这是早期版本；安装可用不等于所有真实宿主和模型行为均已验证，具体边界见下文。

## 一行安装

在 **Linux、macOS 或 Windows 的 WSL 终端**中执行（需已安装 **Node.js 22.19+（22.x）或 24+**，包含 npm）：

```sh
npm install -g common-memory-core@0.3.2
```

安装后运行 `common-memory` 开始配置。无需克隆仓库、手动构建或先启动 Pi。

> 当前源码将首次配置、Agent 接入和日常管理整合在同一个 TUI 入口。
> 自动接入的版本、读取和宿主信任限制见 [TUI 说明](docs/tui-workbench.md)。

- 用 `node --version` 检查版本；没有受支持版本时，先按 [Node.js 官方指引](https://nodejs.org/en/download)
  安装，或用现有版本管理器切换。上面的一行命令安装 Common Memory，**不会安装 Node 或 WSL**。
- Windows 用户在 WSL 内安装，不要在原生 PowerShell 中安装另一份 Core。
- 如遇全局安装权限错误，使用用户级 Node 版本管理器；不建议 `sudo npm install`。
- 不想全局安装？可用 `npx --yes common-memory-core@0.3.2` 运行已发布版本。
- 本版仍有必需的 Pi **0.84.4** peer 依赖：仅使用 CLI/MCP 也会安装该依赖树，但不会自动启动或配置 Pi。

## 第一次使用与日常管理

只需运行一个入口：

```sh
common-memory
```

首次使用依次完成 **模型配置 → Agent 选择 → 自动安装**：

1. **配置模型**：选择 Provider，填写或确认 Base URL，隐藏输入 API Key，再选择 Model。
   预置 Provider 提供默认 URL，并从填写的地址获取实时模型目录；Custom 手动填写 Model。
2. **选择 Agent**：查看 Pi、Codex、ChatGPT 的可接入状态，Space 选择 / 取消，Enter 应用并自动安装。
   可以不接入任何 Agent。安装后退出初始化；中断的接入步骤可在下次启动继续。

完成初始化后，再次运行 `common-memory` 直接进入主 TUI：

| 栏目 | 操作 |
| --- | --- |
| **Agent Integration** | Space 修改当前选择，Enter 按差异安装或移除接入；保留仍然选中的 Agent |
| **Memory Control** | **Search / View Memory** 查找、查看授权记忆；**Adjust Memory** 用自然语言调整记忆并查看处理状态 |
| **Model & Configuration** | **Current Configuration** 查看配置和密钥状态；**Change Model / Provider** 重进模型配置，另可设置网络、测试连接或完整卸载 |

例如，保留 Pi、取消 Codex、勾选 ChatGPT 后，Enter 会保留 Pi、移除 Codex 接入并安装 ChatGPT 接入。
记忆调整可以直接描述“把关于 XX 的记忆删掉”“以后 XX 改为 XX”，或选中已授权读写的项目后请求
“把这个偏好提升为全局偏好”。模型理解请求，由原 Writer/Core 校验并提交；不需要手动编辑文件。

上下键选择，Enter 提交，Esc 返回（首页退出）。提交后的取消不撤回持久队列中的请求。
默认授权个人记忆和用户表达；项目及导入授权仍需显式配置，不会自动扩大。
Pi、Codex 与 ChatGPT 的实际接入范围、版本和宿主信任要求见 [TUI 说明](docs/tui-workbench.md)。

默认配置位于 `~/.common-memory/config.json`，API Key 保存在同目录的私有 `.env` 中；
`COMMON_MEMORY_HOME` 可指定其他配置目录。默认长期记忆位于
`~/.common-memory/data/memory/`，实际路径可在 **Current Configuration** 查看。

## 可以做什么

| 功能 | 说明 |
| --- | --- |
| 一份本地长期记忆 | Profile、Preferences 和项目 Markdown；没有向量库或检索索引 |
| 自动会话维护 | Pi / Codex 接入按十次已完成交互封批，真实退出交接尾批；队列持久保存 |
| 导入已有材料 | 本地 `.md` 文件走 `import`；其他 Agent 的可见理解走 MCP `memory_init`，保留来源 |
| 授权读取 | Pi 提示注入、原生 `memory_read`、MCP `memory_read` 和 CLI `show` 使用同一份文件 |
| 可恢复写入 | SQLite 保存队列、租约和来源链接；Core 校验授权、并发版本与恢复凭据后提交 |
| 统一管理 | `common-memory` 管理 Agent 接入、查找授权记忆、用自然语言调整记忆和配置模型 |

## 自动化与兼容命令

日常管理均从 `common-memory` 的 TUI 完成。已有子命令继续供脚本、协议启动和兼容使用；
不需要记住它们来安装或移除 Agent、查看或调整记忆、修改模型配置。

```sh
common-memory show --plain              # 纯文本读取（非 TTY 的 show 也保持文本输出）
common-memory --version                 # 安装版本
common-memory status                    # 技术状态与故障排查
common-memory import notes.md --author user  # 先授权 document_import；导入不等于逐句确认
common-memory flush                     # 处理可执行的队列，不封未完成会话
common-memory session-drain             # 恢复持久会话交接
common-memory --help                    # 入口说明；自动化命令见使用指南
```

`show`、`config`、`config --network` 和 `uninstall` 保留为兼容快捷入口；
完整命令参考见 [使用指南](docs/usage.md#commands)。

## 平台与接入边界

| 使用方式 | v0.3 要求 |
| --- | --- |
| Linux / macOS | Node 22.19+（22.x）或 24+；相同 npm 安装命令。CI 覆盖 Core 和安装消费，不能代替真实 Desktop UI 验收 |
| Windows | Core 运行在 WSL；原生 Windows 桌面宿主通过生成的 WSL 桥接访问同一存储 |
| Pi | **0.84.4**；在同一 POSIX / WSL 环境运行，使用相同 `COMMON_MEMORY_HOME` |
| Codex / ChatGPT Work 会话捕获 | rollout 仅支持 **Codex 0.153.4**；未知格式拒绝，不猜测用户交付 |
| 其他本地 MCP 宿主 | **stdio only**；`read`、`init`、`relay` 能力在启动时固定 |

只读使用不需要模型 API Key，也不会打开 SQLite。客户端可用性和受管理安装状态不证明客户端在线、
Hooks 已获宿主信任或真实连接验收通过。捕获和维护需要相应授权与有效模型配置。
完整真实客户端事件组合、Desktop UI Hook 信任与不同模型的语义质量仍需使用者验证；
这不是联网多租户服务，也没有 HTTP MCP 或 V1 自动迁移。

## 隐私与数据安全

- **本地存储不等于离线运行**：获授权的内容会发送给你配置的模型提供商；其数据政策适用。
- Markdown 和 SQLite 是本地明文；敏感扫描不能识别所有秘密，请不要把凭据放进记忆。
- 导入内容、assistant/tool 上下文不是经过认证的用户声明，不能单独授权遗忘用户来源内容。
- 忘记当前内容不等于删除宿主聊天记录、外部备份或提供商记录。
- 升级前停止所有写端（包括 detached `session-drain`）并备份**完整 dataRoot 和配置目录**。
  SQLite 是持久队列与来源存储，不能当缓存删除。

详见 [安全说明](SECURITY.md) 与 [升级、备份及卸载](docs/releasing.md#升级备份和卸载)。

## 文档与开发

- [完整使用与配置指南](docs/usage.md)：模型、代理、导入、MCP、Pi、Codex、Work 和 WSL
- [会话接入及验收边界](docs/session-integration.md)
- [发布与 CI/CD](docs/releasing.md) · [变更记录](CHANGELOG.md) · [文档目录](docs/00-index.md)
- [Memory Benchmark](https://github.com/Mr-remon219/memory-benchmark)：独立 Writer 评测项目

源码开发需要 Node 22.19+（22.x）或 24+：

```sh
git clone https://github.com/Mr-remon219/common-memory.git
cd common-memory
npm ci
npm run verify                         # 类型、边界、全量测试、构建
npm run test:consumer                   # tarball 隔离安装；需要 npm 网络，不调用真实模型
node dist/cli/main.js
```

CI 检查 Linux、macOS 和 Windows；发布后另从 npm registry 安装核验。测试证明协议和本地
提交机制，不证明真实模型永远正确判断应该保留或忘记什么。

## License

[MIT](LICENSE) © 2026 Mr-remon219 and contributors.
