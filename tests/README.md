# 测试取舍与关键行为

目标是用可定位的失败保护用户数据，不以用例数量或预设模型答案衡量质量。
`npm run verify` 仍执行全部单测；没有通过 skip、排除文件或合并断言来隐藏测试数量。

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

## 验证与限制

本轮 Node 24.20.0：全量 **521 → 508** 项，`node scripts/verify.mjs` 的类型、边界、测试、构建均通过。没有为了降到某个数字删除有效的边界测试。

另在临时副本中独立注入两种回归：跳过 receipt→SQLite 恢复、允许 incomplete 会话变成 complete。新测试分别因来源队列未恢复、完成状态错误而失败；未修改工作区实现。

这证明本地执行与恢复合同，不证明真实模型的记忆选择、语义纠正或遗忘判断质量。Writer benchmark 在独立的 `../../memory-benchmark` 仓库；真实模型、真实 Desktop UI、Windows/macOS 实机行为不能由本轮 Linux 离线测试代替。
