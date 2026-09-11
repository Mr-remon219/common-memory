# Common Memory

[![CI](https://github.com/Mr-remon219/common-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/Mr-remon219/common-memory/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/common-memory-core)](https://www.npmjs.com/package/common-memory-core)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**让不同 AI 助手使用同一份由你掌握的长期记忆。**

Common Memory 把长期内容保存在本机的 Markdown 中，通过 Pi 扩展、Codex / ChatGPT Work
会话接入和本地 MCP，让助手读取获授权的个人偏好、背景与项目上下文。模型提出维护决定，
本地 Core 校验后写入；你可以直接查看和编辑文件。

**v0.3.0** · npm 包名 `common-memory-core` · 命令 `common-memory` · MIT 许可证。
这是早期版本；安装可用不等于所有真实宿主和模型行为均已验证，具体边界见下文。

## 一行安装

在 **Linux、macOS 或 Windows 的 WSL 终端**中执行（需已安装 **Node.js 24.x**，包含 npm）：

```sh
npm install -g common-memory-core@0.3.0
```

安装后运行 `common-memory` 开始配置。无需克隆仓库、手动构建或先启动 Pi。

> v0.3.0 提供极简 Setup、管理和卸载流程。
> 自动接入的版本、读取和宿主信任限制见 [TUI 说明](docs/tui-workbench.md)。

- 用 `node --version` 检查版本；没有 Node 24 时，先按 [Node.js 官方指引](https://nodejs.org/en/download)
  安装，或用现有版本管理器切换。上面的一行命令安装 Common Memory，**不会安装 Node 或 WSL**。
- Windows 用户在 WSL 内安装，不要在原生 PowerShell 中安装另一份 Core。
- 如遇全局安装权限错误，使用用户级 Node 版本管理器；不建议 `sudo npm install`。
- 不想全局安装？可用 `npx --yes common-memory-core@0.3.0` 运行已发布版本。
- 本版仍有必需的 Pi **0.84.4** peer 依赖：仅使用 CLI/MCP 也会安装该依赖树，但不会自动启动或配置 Pi。

## 第一次使用

以下描述当前源码，重设计的进度和限制见 [TUI 说明](docs/tui-workbench.md)。

1. **配置**：运行 `common-memory`，单选 Provider、填写 API Key、从实时目录单选模型。
   预置官方 URL；Custom 只填写 URL / Key / Model，不扫描。启动和后台不扫描模型。
2. **接入**：紧接着扫描客户端，Space 多选、Enter 自动安装配置，然后 Done 退出。
   Pi 0.84.4 支持会话维护；Codex 未验证版本和 Desktop 自动安装读取接入。Hooks 信任不能跳过。
3. **管理**：运行 `common-memory show`，选择 **Overview / View Memory / Modify Memory**。
   修改时直接输入自然语言，经同一 Writer/Core 处理；不提供 Markdown 编辑器或删除按钮。
4. **卸载**：`common-memory uninstall` 可移除选中的接入，或卸载确切的全局 npm 安装。
   Memory Data 单独确认，默认保留整个数据目录。

上下键选择，Enter 提交，Esc 返回（首页退出）。提交后的取消不撤回持久队列中的请求。
默认授权个人记忆和用户表达；项目及导入授权仍需显式配置，不会自动扩大。

默认配置位于 `~/.common-memory/config.json`，API Key 保存在同目录的私有 `.env` 中；
`COMMON_MEMORY_HOME` 可指定其他配置目录。默认长期记忆位于
`~/.common-memory/data/memory/`，实际路径以 `common-memory status` 为准。

## 可以做什么

| 功能 | 说明 |
| --- | --- |
| 一份本地长期记忆 | Profile、Preferences 和项目 Markdown；没有向量库或检索索引 |
| 自动会话维护 | Pi / Codex 接入按十次已完成交互封批，真实退出交接尾批；队列持久保存 |
| 导入已有材料 | 本地 `.md` 文件走 `import`；其他 Agent 的可见理解走 MCP `memory_init`，保留来源 |
| 授权读取 | Pi 提示注入、原生 `memory_read`、MCP `memory_read` 和 CLI `show` 使用同一份文件 |
| 可恢复写入 | SQLite 保存队列、租约和来源链接；Core 校验授权、并发版本与恢复凭据后提交 |
| 简洁管理 | `show` 查看位置和大小、浏览授权记忆、用自然语言修改个人记忆 |

## 常用命令

```sh
common-memory                          # 首次配置；已配置时打开管理菜单
common-memory show                      # Overview / View Memory / Modify Memory
common-memory uninstall                 # 移除接入 / 完整卸载；默认保留 Memory Data
common-memory config                    # 主动重进模型配置页
common-memory show --plain              # 纯文本读取（非 TTY 的 show 也保持文本输出）
common-memory --version                 # 安装版本
common-memory status                    # 技术状态与故障排查
common-memory import notes.md --author user  # 先授权 document_import；导入不等于逐句确认
common-memory flush                     # 处理可执行的队列，不封未完成会话
common-memory session-drain             # 恢复持久会话交接
common-memory --help                    # 简洁入口；自动化命令见使用指南
```

## 平台与接入边界

| 使用方式 | v0.3 要求 |
| --- | --- |
| Linux / macOS | Node 24.x；相同 npm 安装命令。CI 覆盖 Core 和安装消费，不能代替真实 Desktop UI 验收 |
| Windows | Core 运行在 WSL；原生 Windows 桌面宿主通过生成的 WSL 桥接访问同一存储 |
| Pi | **0.84.4**；在同一 POSIX / WSL 环境运行，使用相同 `COMMON_MEMORY_HOME` |
| Codex / ChatGPT Work 会话捕获 | rollout 仅支持 **Codex 0.153.4**；未知格式拒绝，不猜测用户交付 |
| 其他本地 MCP 宿主 | **stdio only**；`read`、`init`、`relay` 能力在启动时固定 |

只读使用不需要模型 API Key，也不会打开 SQLite。Overview 的客户端发现不证明已接入，
当前均标注接入未验证。捕获和维护需要相应授权与有效模型配置。
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

源码开发需要 Node 24.x：

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
