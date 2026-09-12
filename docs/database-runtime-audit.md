# 数据库运行时审查

本记录对应 v0.3.2 的数据库和 Node 兼容性修复。当前会话行为仍以
[会话接入](session-integration.md) 为准。

## 入口和资源所有权

所有生产 SQLite 连接统一经过 `src/v2/sqlite.ts` 的 `openDatabase`，仅在实际打开
数据库时加载 `node:sqlite`。类型引用不加载 SQLite；边界检查禁止新增直接加载入口。

| 数据库 / 操作 | 入口与清理 |
| --- | --- |
| `runtime.sqlite`：队列、任务租约、重试、来源关联、收据、会话缓存和迁移 | `RuntimeStore` 保持 WAL、`synchronous=FULL` 和同步事务；初始化失败关闭连接；正常生命周期由持有者关闭 |
| 状态、重试、flush、文档导入、自然语言调整、session-drain | CLI 持有 Store/Writer，并在 `finally` 关闭；状态仅在已有数据库时打开，但可能执行兼容迁移，不是 SQLite 只读连接 |
| Codex / Work 事件入队、inbox 消费和快照刷新 | Host adapter 建表、迁移和 ingress 初始化均在连接清理的 `try/finally` 内 |
| Writer 恢复与提交 | 仓库锁 → 数据库事务；模型调用在锁外；初始化恢复失败关闭 Store；ConfiguredWriter 关闭时等待在途任务并关闭模型网络资源 |
| Pi / MCP 写入接入 | 宿主持有 ConfiguredWriter；宿主初始化失败也关闭 Writer；正常退出沿原有 drain/cancel/close 流程处理 |
| `runtime/repository-lock.sqlite`：仓库写入互斥 | 同步回调完成后提交，失败时关闭并释放事务；拒绝 Promise / thenable 返回值 |
| `<home>/.installation/runtime/repository-lock.sqlite`：接入安装互斥 | 复用仓库锁实现；保留原有安装文件恢复流程 |
| 卸载前检查运行中租约 | 用 `readOnly: true` 打开已有 `runtime.sqlite`，查询失败也关闭；不创建或重建队列 |
| Memory Search/View、配置查看、帮助、MCP `read` | 不打开数据库，也不加载 SQLite；直接读取授权的 Markdown / 配置 |

保留现有路径、符号链接和硬链接检查。SQLite 的等待超时仍分别为：普通队列 5000 ms、
Hook 入队 150 ms、仓库锁 2000 ms、卸载租约检查 100 ms。运行时数据库是持久状态，
报错不会触发删除或“重建索引”。同步回调约束不授权异步工作在事务内运行；不能把
`async` 函数交给锁或事务。Markdown 的写入权和来源授权不变。

## 终端重绘

Node 的 SQLite 实验性警告会排队输出。若它落在 Clack 提示绘制之后，stdout/stderr
共用的终端光标会被移动，下一次方向键重绘便留下重复行。

CLI 在启动时以及每次 select、multiselect、text、password、confirm 前等待一次
`setImmediate`，让此前数据库操作排队的警告先输出。所有 CLI 提示通过统一模块调用，
边界检查禁止绕过。警告保持可见，不修改全局 warning handler。此机制针对本 CLI
同步数据库操作产生的排队警告；不声称能控制其他进程或宿主自己的终端输出。

## Node 最低版本

`engines.node` 为 `^22.19.0 || >=24.0.0`，开发类型使用 Node 22 系列。
Pi 0.84.4 和 undici 8.10.2 的依赖清单都要求至少 22.19.0，因此当前依赖组合不能降到
Node 20。Node 23 不在支持范围内。

最低版本实测发现 Node 22.19.0 / 22.23.1 的 SQLite TEXT 返回值会在 NUL 处截断，
但数据库内的字节仍完整。正文读取改为 SQL `CAST(... AS BLOB)` 后按 UTF-8 解码，
覆盖观察、输入/交付认证、会话投影、host inbox 和快照；原有 TEXT 存储与字节预算不变。
测试检查含 NUL、中文、emoji 的正文在去重、重启、重试和上下文读取后的完整性，
以及截断前缀不能被错误认证为原输入。

- SQLite 无需实验开关始于 22.13；连接 `timeout` 选项始于 22.16，已低于所选下限。
  依据：[Node SQLite API](https://nodejs.org/api/sqlite.html)。
- 测试加载器使用的同步 `module.registerHooks` 始于 22.15。
  依据：[Node module API](https://nodejs.org/api/module.html)。
- 验证脚本、包引擎声明和 CI 使用同一支持范围；CI 配置为 Node 22.19.0 / 24，
  Linux、macOS、Windows 完整 gate，Linux/macOS 另测隔离安装。
- `--use-env-proxy` 始于 22.21 / 24.5；旧版本的宿主代理回归使用显式的宿主 dispatcher。
  Common Memory 的显式网络配置不依赖此开关，也不接管宿主全局 dispatcher。
  依据：[Node CLI API](https://nodejs.org/api/cli.html#--use-env-proxy)。

## 回归证据

- `tests/cli/terminal-startup.test.ts`：真实 Clack 渲染、方向键/Esc、raw mode 还原，
  使用中首次打开 SQLite、锁失败、只读卸载查询和五种提示的警告顺序。
- `tests/cli/database-lifecycle.test.ts`、`tests/v2/host-startup-cleanup.test.ts`：
  真数据库配合错误模式，验证迁移、host adapter、Pi/MCP 初始化、卸载检查失败后的关闭。
- `tests/v2/runtime.test.ts`、`tests/v2/lock.test.ts`：异步返回值拒绝、事务回滚、锁重新获取。
  原有 concurrency、recovery、cancellation 等测试继续验证租约、并发启动和恢复契约。
- `tests/mcp/protocol.test.ts` 和打包 consumer：只读进程禁止解析 `node:sqlite`，
  继续验证工具调用及 Markdown 读取。安装采用 `--engine-strict`，验证依赖树的实际最低版本。

2026-09-12 本地 Linux 验证：

| 运行时 | 结果 |
| --- | --- |
| Node 22.19.0 | 完整 gate：49 个测试文件、558 项通过，构建通过；严格 engines 的 tarball 隔离安装通过 |
| Node 24.20.0 | 完整 gate：49 个测试文件、558 项通过，构建通过；严格 engines 的 tarball 隔离安装通过 |
| Node 22.19.0 / 22.23.1 | Linux PTY 连续方向键后仅一组菜单，Esc 退出恢复终端状态 |

Linux 本地测试不能代替 macOS/Windows CI 或 Windows Terminal / 真实宿主验收。
