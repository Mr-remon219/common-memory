# 发布与用户安装

## 当前状态

v0.3 使用所有者确认的 MIT 许可证。npm 版本是 **0.3.1**，GitHub tag 是 **v0.3.1**，
包名 `common-memory-core`，可执行命令 `common-memory`，默认发布标签 `latest`。
这是面向早期使用者的版本，不声称已经完成全部真实客户端验收。

Linux、macOS 和 WSL 在 Node 24 环境使用同一行安装命令：

```sh
npm install -g common-memory-core@0.3.1
```

安装 Node / WSL 是前置要求，不包含在这个 npm 命令中。详细说明见 [README](../README.md)。

## 支持范围

| 路径 | 要求与证据边界 |
| --- | --- |
| Core、CLI、stdio MCP | Node **24.x**；Linux / macOS CI 覆盖完整 gate 和真实 tarball 隔离安装 |
| Pi | 精确 peer 版本 **0.84.4**；事件契约和包加载测试不等于所有真实交互组合已验证 |
| Codex / Work 会话捕获 | rollout 仅接受 **Codex 0.153.4**；未知版本拒绝而非猜测；真实 UI Hook 信任仍需验收 |
| Windows 用户 | 产品部署在 WSL；原生 Windows 是薄桥接，不是第二套 Core 部署。Windows CI 结果应单独查看 |
| macOS | 与 Linux 共用 npm 安装入口；macOS CI 覆盖代码及安装消费，真实 Desktop UI 验收仍独立 |
| 模型 | Responses 或 Chat Completions，必须满足所选协议；假模型测试不证明实际模型的记忆判断质量 |

Pi peer 暂时是**必需依赖**。即使只用 CLI/MCP，npm 也会安装对应的 Pi peer 依赖树；
当前版本不承诺无 Pi 的轻量安装。不要用 `--legacy-peer-deps` 掩盖不兼容的宿主版本。
不要把 Windows CI 的纯代码检查理解成 Windows 原生宿主支持。

## 版本和权限

- `package.json.version`、锁文件、README 安装版本、`test:published` 和 GitHub tag 必须一致。
- 仓库具有 `LICENSE` 和 `package.json.license: MIT`，不再设置 `private: true`。
- 用 Node 24 执行 `npm install --package-lock-only --ignore-scripts` 同步变更后的元数据。
- `npm run release:check` 检查发布元数据及许可证文件存在，不能代替贡献权利审查或 npm 权限检查。
- npm 包的同一个版本不能覆盖；发现问题时修复源码并发布新的补丁版本，不移动已有发布 tag。

## 发布前的完整检查

先停止修改这一份工作树，确认提交包含所有需要的源码和文档；不能仅提交已跟踪文件而
遗漏新加的 TUI 模块或测试。不要提交 `.env`、记忆目录、SQLite、个人会话、编辑器交换文件。

```sh
node --version                 # 24.x
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

`core-ci` 在 Ubuntu、macOS 和 Windows 执行相同完整 gate；Ubuntu / macOS 追加隔离
tarball 测试。macOS 测试临时目录采用真实路径，避免系统 `/var` 别名与禁止符号链接的
存储约束冲突；不会放松产品的路径安全检查。发布者应检查本次提交对应的 CI，而不是沿用
历史通过记录。安装测试联网失败不是产品已经通过的证据。

`prepublishOnly` 依次执行发布锁检查、完整 gate 和隔离消费者检查；`prepack` 构建生产产物。
不要使用 `npm publish --ignore-scripts` 绕过检查。验证失败时保留原输出并修复原因。

## npm 发布（维护者执行）

完成上述本地检查后，将候选提交推送到获授权的发布候选分支，等待该精确 SHA 的
`core-ci` 全平台通过，再快进正式分支并发布 npm。Actions 不能验证尚未推送的本地提交；
旧版 main 的通过记录不能代替新候选版本，若不允许推送候选分支则停在本地验证阶段。
任何修复都要重新验证修复后的 SHA，不移动已发布 tag。

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
npm view common-memory-core@0.3.1 version dist.integrity
npm install -g common-memory-core@0.3.1
common-memory --version
common-memory --help
npm run test:published
```

npm 发布成功并完成本地 registry 检查后，创建 GitHub Release `v0.3.1`。它会触发
`published-package` 工作流：Ubuntu / macOS 实际执行上述一行全局安装，核对 CLI 版本，
然后从 npm 下载 tarball 验证类型导出、Writer 提交/重启、Pi 模块和无 Key 的只读 MCP。
也可通过 Actions 的 Run workflow 输入精确版本手动重跑。这个工作流**不发布包**，只有
只读仓库权限，不需要 npm 写 token。

必须查看这次 commit 的 `core-ci` 和这次 Release 的 `published-package` 结果。任何失败都
保留日志、定位原因并修复；网络失败也不能标成通过。Linux CI 不代表 WSL 桌面宿主，macOS
CI 也不代表真实 Desktop UI 信任和事件组合已验收。

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
