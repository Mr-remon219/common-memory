# 发布与用户安装

## 当前状态

v0.3 使用所有者确认的 MIT 许可证。npm 版本是 **0.3.6**，GitHub tag 是 **v0.3.6**，
包名 `common-memory-core`，可执行命令 `common-memory`，默认发布标签 `latest`。
这是面向早期使用者的版本，不声称已经完成全部真实客户端验收。

数据库入口、终端警告与兼容性依据见 [数据库运行时审查](database-runtime-audit.md)。

Linux、macOS 和 WSL 在 Node 22.19+（22.x）或 24+ 环境使用同一行安装命令：

```sh
npm install -g common-memory-core@0.3.6
```

安装 Node / WSL 是前置要求，不包含在这个 npm 命令中。详细说明见 [README](../README.md)。

## 支持范围

| 路径 | 要求与证据边界 |
| --- | --- |
| Core、CLI、stdio MCP | Node **22.19+（22.x）或 24+**；Linux / macOS CI 覆盖完整 gate 和真实 tarball 隔离安装 |
| Pi | peer 为 `*`，发现与安装不限制版本号；**0.84.4** 是事件契约验证基线，不等于所有历史版本和真实交互组合已验证 |
| Codex / Work 会话捕获 | rollout 接受 **Codex >=0.153.4** 的三段数字版本，无上限；未知结构拒绝而非猜测；真实 UI Hook 信任仍需验收 |
| Windows 用户 | 产品部署在 WSL；原生 Windows 是薄桥接，不是第二套 Core 部署。Windows CI 结果应单独查看 |
| macOS | 与 Linux 共用 npm 安装入口；macOS CI 覆盖代码及安装消费，真实 Desktop UI 验收仍独立 |
| 模型 | Responses 或 Chat Completions，必须满足所选协议；假模型测试不证明实际模型的记忆判断质量 |

Pi peer 暂时是**必需依赖**。即使只用 CLI/MCP，npm 也会安装对应的 Pi peer 依赖树；
当前版本不承诺无 Pi 的轻量安装。开发 lockfile 保留验证基线，不强制用户把宿主降级到该版本。
不要把 Windows 桥接 CI 理解成 Windows 原生 Core 部署或真实 Desktop UI 验收。

## 版本和权限

- `package.json.version`、锁文件、README 安装版本、`test:published` 和 GitHub tag 必须一致。
- 仓库具有 `LICENSE` 和 `package.json.license: MIT`，不再设置 `private: true`。
- 用 Node 22.19+（22.x）或 24+ 执行 `npm install --package-lock-only --ignore-scripts` 同步变更后的元数据。
- `npm run release:check` 检查发布元数据及许可证文件存在，不能代替贡献权利审查或 npm 权限检查。
- npm 包的同一个版本不能覆盖；发现问题时修复源码并发布新的补丁版本，不移动已有发布 tag。

## 发布前的完整检查

先停止修改这一份工作树，确认提交包含所有需要的源码和文档；不能仅提交已跟踪文件而
遗漏新加的 TUI 模块或测试。不要提交 `.env`、记忆目录、SQLite、个人会话、编辑器交换文件。

```sh
node --version                 # 22.19+ (22.x) or 24+
npm ci
npm run release:check
node scripts/verify.mjs        # typecheck → boundaries → full tests → build，各一次
npm run test:consumer          # 使用刚构建的 tarball；隔离 npm 安装，需要 registry 网络
npm audit --omit=dev
npm pack --dry-run             # 检查文件清单；prepack 会重新构建，避免陈旧 dist
```

`test:consumer` 不再链接工作树的 `node_modules`：它在临时目录安装 tarball 和生产/peer
依赖（禁止安装脚本，不要求用户拥有 TypeScript），编译外部 TypeScript 消费者，并验证
打包 prompt、Writer 提交/重启读取、Pi entry、CLI 命令链接、无 Key 的只读 MCP 和 SQLite
不被只读端打开。它不调用真实模型，也不读取用户存储。

`core-ci` 的发布门槛按部署环境拆分：

| 环境 | Node | 必须通过 |
| --- | --- | --- |
| Linux | 22.19.0 / 24 | 完整 gate、构建后的隔离 npm 安装验证 |
| macOS | 22.19.0 / 24 | 同 Linux；继续承诺支持，因此不缩减 Core 验证 |
| 原生 Windows | 24（测试驱动器） | `npm run test:windows`，真实 Windows PowerShell 5.1 与原生参数接收程序；不运行 Core/SQLite/Writer 全套 |
| 真实 WSL | 22.19.0 / 24 | `npm run test:wsl`，隔离 npm 安装、真实 PTY TUI、wsl.exe 只读 MCP、生成的 PowerShell 宿主桥接 |

Windows 桥接测试验证固定发行版/用户、参数边界、路径转换、引号/反斜杠、Unicode stdin、
退出码、身份失败与配置生成。Windows 测试驱动器的 Node 版本不代表在 Windows 部署 Core。
macOS 临时目录采用真实路径，不放松产品的符号链接安全约束。

真实 WSL 验证在发布者的 WSL 机器执行；GitHub 托管的普通 Linux/Windows runner 不作替代。
需要 WSL interop、Windows PowerShell、`wslpath`、Python 3 和 Windows 本地临时目录；
脚本缺少前置环境会失败，不计为通过。使用合成数据和独立临时安装，不改个人 Agent 配置。
PowerShell 遵循系统脚本策略；不添加 ExecutionPolicy Bypass。

```sh
npm run test:windows           # 原生 Windows，或具备 PowerShell interop 的 WSL
npm run test:wsl               # 真实 WSL；先构建，Node 22.19 / 24 分别运行
# 发布后也可对确切 registry 产物验证：
npm run test:wsl -- --registry-version 0.3.6
```

WSL 冒烟使用真实的原生合成宿主进程，通过生成的 Hook 调用 Core；验证宿主身份、路径转换、
刷新、Unicode 与宿主退出后的 Writer drain。它不代表真实 ChatGPT Desktop UI、信任确认或
未来 PowerShell Agent 的所有事件组合已验收。每次发布记录 SHA、包版本、Node/WSL 版本与日志。

`prepublishOnly` 依次执行发布锁检查、完整 gate 和隔离消费者检查；`prepack` 构建生产产物。
不要使用 `npm publish --ignore-scripts` 绕过检查。验证失败时保留原输出并修复原因。

## npm 发布（维护者执行）

完成本地 gate 与真实 WSL 检查后，将提交推送到获授权的正式分支或候选分支，等待该精确
SHA 的 `core-ci` 全部通过，再发布 npm。候选分支不是必需步骤；若已推送正式分支，不再为
同一 SHA 额外创建候选分支。Actions 不能验证尚未推送的本地提交；旧提交的成功不能代替
本次发布。任何修复都要验证修复后的 SHA，不移动已发布 tag。

README 先写好正式版本的安装说明；发布完成后使用 registry 返回的产物验证，不用
工作树构建冒充已发布包。

```sh
npm login
npm whoami
npm view common-memory-core versions --json
# 首次发布时 E404 可能是尚未存在，也可能是权限问题；不是名称预留证明。
npm publish --access public --tag latest
```

不要把 npm token/API Key 写入仓库。认证、账号 2FA、包名所有权、GitHub 仓库可见性和
Release/tag 都要由维护者在对应服务上完成。本文和本地验证不会自动推送或发布。
发布后从一个新目录安装并核对 registry 中的版本：

```sh
npm view common-memory-core@0.3.6 version dist.integrity
npm install -g common-memory-core@0.3.6
common-memory --version
common-memory --help
npm run test:published
```

npm 发布成功并完成本地 registry 检查后，创建 GitHub Release `v0.3.6`。它会触发
`published-package` 工作流：Ubuntu / macOS 实际执行上述一行全局安装，核对 CLI 版本，
然后从 npm 下载 tarball 验证类型导出、Writer 提交/重启、Pi 模块和无 Key 的只读 MCP。
也可通过 Actions 的 Run workflow 输入精确版本手动重跑。这个工作流**不发布包**，只有
只读仓库权限，不需要 npm 写 token。

必须查看这次 commit 的 `core-ci` 和这次 Release 的 `published-package` 结果。任何失败都
保留日志、定位原因并修复；网络失败也不能标成通过。Linux CI 不代表 WSL 桌面宿主，macOS
CI 也不代表真实 Desktop UI 信任和事件组合已验收。

从 v0.3.4 开始，`core-ci` 的 push 仅匹配分支；tag 不重复执行 Core 全套。Release 仍触发
独立的 `published-package` registry 安装验证。发布收尾时按 SHA 列出全部运行，确认本次
分支 CI 与 Release 检查完成，不沿用旧版本或另一个 SHA 的结果：

```sh
gh run list --commit <release-commit-sha> --limit 100 --json databaseId,workflowName,headBranch,status,conclusion,url
```

同一提交也可能因 runner 负载而暴露测试超时。保留首次失败记录，修复测试生命周期与资源
预算；重跑成功仅证明本次重跑通过。已发布 tag 不移动，后续 CI 修复提交到 main。

未来如需自动发布，可以在 npm 包设置中配置 GitHub Actions trusted publisher；工作流
身份必须与设置一致。目前没有自动发布工作流，也不依赖未配置的 OIDC 权限。
参考：[npm 生命周期](https://docs.npmjs.com/cli/v11/using-npm/scripts)、
[trusted publishing](https://docs.npmjs.com/trusted-publishers)。

## 从 GitHub 使用（源码路径）

项目按 [MIT](../LICENSE) 分发。源码开发和贡献使用：

```sh
git clone https://github.com/Mr-remon219/common-memory.git
cd common-memory
npm ci
npm run build
node dist/cli/main.js
```

本版不承诺 `npm install github:...` 直接安装源码；使用上述 clone/build 路径或正式 npm
包。生成的 MCP/Hook 配置固定实际 Node、CLI 和 home 路径，移动安装或切换 Node 后需要重新
生成并审阅。安装的 CLI 与 Pi 宿主必须使用同一个 `COMMON_MEMORY_HOME`。
从旧版本升级到 v0.3.4 后，需要重新生成 Windows Hook bundle，已生成的 `.ps1` 不会随 npm
升级自动改写；重新生成后才包含 PowerShell 引号与末尾反斜杠修复。

## 升级、备份和卸载

- **先停止所有写端**：Pi、MCP、Codex/Work hooks，以及已经脱离宿主的 `session-drain`
  消费者。仅关闭终端不能证明消费者已退出。不同版本不能同时写同一个 dataRoot。
- 用 `common-memory status` 核对配置目录及真实 dataRoot。离线备份配置目录和**整个
  dataRoot**（Markdown、runtime.sqlite、现存的 SQLite sidecar、registry、receipts 和
  recovery 元数据）；dataRoot 可以在 home 外，不能只备份 `~/.common-memory`。
- SQLite 是持久队列与来源链接存储，**不能删除后从 Markdown 重建**。备份中的 `.env`
  和对话缓存同样敏感；使用私有权限和适当的加密存储。
- 安装新版本后重新生成受路径影响的集成，先检查 `status` / `show`，有待处理交接时显式
  运行 `session-drain`。V1 或未知 schema 不自动迁移；不要尝试靠删除数据库完成升级。
- 回退前停止新版本所有写端，必要时恢复同一时点的完整离线备份；不保证旧程序可打开新
  schema。恢复到新路径时需要更新配置及项目/宿主路径，不能假定路径自动迁移。
- `npm uninstall -g common-memory-core` 只卸载程序。先在宿主中移除对应 hooks、MCP 配置和
  Pi 资源注册；用户数据不自动删除。不要把撤销宿主注册理解成删除远端已披露的内容。
