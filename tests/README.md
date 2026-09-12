# 测试取舍与关键行为

目标是用可定位的失败保护用户数据，不以用例数量或预设模型答案衡量质量。
`npm run verify` 在 Linux/macOS 执行完整 Core 套件；Windows 桥接与真实 WSL 冒烟有独立入口。
按部署职责选择套件，不以某个平台未运行的测试冒充已验证。

## 关键行为的负责位置

| 风险 | 主要测试 | 验证的结果 |
| --- | --- | --- |
| 多文件提交只完成一半 | `v2/canonical.test.ts` | 六个阶段真实子进程退出；确认中间混合状态，恢复后两份文件与 receipt 一致；重复恢复无副作用 |
| Markdown 成功但 SQLite 回滚 | `v2/writer-recovery.test.ts` | 先确认真实崩溃窗口，再重启 Writer；不重调模型，恢复来源关联、队列与会话完成状态；随后 forget 清除来源正文和上下文，重放不复活 |
| idle 被误报为完成 | `v2/session-lifecycle.test.ts` | dead-letter 不自动重试；显式 retry 后跨重启重算状态；incomplete 尾轮即使处理成功仍不能 complete |
| 未交付输入、跨轮混批或越界上下文 | `v2/session.test.ts`、`v2/pi-integration.test.ts`、`cli/codex-hook.test.ts`、`cli/work-session.test.ts` | 实际交付身份、十轮封批、整轮资源边界、独立上下文授权与宿主状态 |
| 导入入队半途失败 | `v2/document-import.test.ts` | 第二次插入后抛错，所有分块回滚；重开数据库后完整重试，不误判为 duplicate |
| 模型多条决定部分越权 | `v2/writer.test.ts` | agent/document 导入先提出合法追加、再提出非法覆盖或遗忘；整批拒绝，Markdown、receipt、来源链接均不部分提交，原观察不丢失 |
| 外部编辑、租约竞争、取消后的迟到响应 | `v2/writer.test.ts`、`v2/concurrency.test.ts` | 不覆盖人工内容、不双重消费、不把失败或失效租约报告为成功 |
| 宿主退出丢尾批／只读进程越权 | `cli/session-drain.test.ts`、`mcp/protocol.test.ts` | 真实进程和 stdio 边界、本地假提供者、持久提交；read 不打开 runtime SQLite |

## 冗余处理原则

- 参数化的安全输入、代理路由、协议状态不是仅因数量多就删除：不同拒绝路径仍需独立定位。
- 删除 Writer 中七条“指定语义答案再检查写入”的 fixture；它们没有验证模型判断。retain/update/forget、scope 与来源保护由行为测试负责。
- Canonical 的五条同阶段抛错恢复测试由更强的多文件进程退出测试替代；外部编辑冲突的抛错测试保留。
- Writer 的通用 CAS、注册移除、租约过期已有独立竞态用例，不在 promotion 参数矩阵中重复；promotion 特有的披露、只读、跨项目拒绝保留。
- 不再构造“旧 schema”与当前 schema 比较；直接验证当前合同对非法 admission/lifetime 的拒绝。
- CLI 只验证解析、预处理、授权错误向退出码的映射，以及跨进程重放。编码／大小／文件类型的全矩阵留在预处理层，不重复启动 CLI。
- 删除只断言轨迹数量的 evaluation 测试。默认 ablation 测试从完整实验矩阵改为小型可手算场景，检查报告、删失等待、重启、事件顺序、批容量与重复执行。完整实验仍可用 `npm run ablate:v2` 显式运行。

## 干净检出与安装测试

完整门禁在 build 前执行单测，不能依赖开发目录残留的 `dist`。安装归属与 Setup 单测通过
`helpers/installation-build.ts` 仅模拟当前 CLI 构建文件是否存在；目标配置文件 IO 仍是真实的，
缺少构建的拒绝路径另有断言。真实产物加载由 build 后的 tarball consumer 验证。
Setup 的脚本化选择次数有界，意外重试会立即失败，不会把错误隐藏成整套测试超时。

## 平台划分与执行成本

- Linux/macOS：Node 22.19.0 和 24 均执行完整 gate 和 npm consumer。持久事务、恢复、来源、租约、只读边界与网络合同仍全部保留。
- 原生 Windows：`npm run test:windows` 只运行 `windows/bridge.test.ts`。用真实 PowerShell 5.1 和 C# 原生参数接收程序验证生成脚本；不启动 Core 数据库或模型。测试中的 WSL 运行时描述和宿主元数据是合成的，参数解析、stdin 与退出状态是真实进程行为。
- WSL：构建后执行 `npm run test:wsl`，从 tarball 隔离安装，使用真实 PTY 驱动首次取消和重复启动/方向键/Esc，再验证真实 wsl.exe 的只读 MCP 和原生合成宿主的 Hook/refresh/Writer drain。入口缺少真实 WSL 时失败。

优化以删除重复执行为主：原生 Windows 不再重复约 560 项 Core 测试；分支提交验证后，tag 不再触发一轮完整矩阵。原先条件跳过的 WSL 桥接单测迁入已安装包的专门冒烟，WSL 不再重复 npm consumer 的类型检查、通用 Writer 和自卸载场景。配置文本的粗略字符串断言由结构化 TOML/argv 检查和真实 PowerShell 执行替代。

macOS 继续承诺支持，因此完整矩阵保留。避免为“减少数量”删除安全拒绝路径、六阶段崩溃恢复或数据库关闭验证。

## 验证证据与限制

每次发布记录实际提交、Node/WSL 版本与日志；历史测试数量不表示当前覆盖。Linux CI 不证明
Windows PowerShell 参数行为；原生 Windows CI 不证明真实 WSL interop。合成宿主冒烟不证明
真实 ChatGPT Desktop UI 信任和所有客户端事件组合。Writer benchmark 仍在独立的
`../../memory-benchmark` 仓库，测试不调用真实模型或读取个人记忆。
