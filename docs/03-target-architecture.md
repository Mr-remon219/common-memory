# 目标架构

```text
宿主 observation reference
  -> MemoryManager（重取并验 digest、构造有界投影）
  -> RemoteDisclosurePolicy + external safety preflight
  -> MemoryModelPort
  -> OpenAI Responses native fetch（store:false）
  -> strict decoder + MemoryAnalysis validator + local policy/compiler
  -> Core autoGovernBatch（nominal authority、幂等、双 revision）
  -> 单事务 Canonical Proposal + Review + Fact

可信 trigger -> SQLite scheduler -> MemoryManager.consolidate

Pi raw input -> accepted prompt -> stable user entry -> successful agent_settled
  -> 单事务 ObservationReference + extract outbox
  -> SQLite lease/fencing worker -> MemoryManager.extract
```

网络、timer 和 scheduler 永不运行在 Core lock 内。Provider 不导入 repository/layout/transaction；Core 不导入 provider 或 scheduler。Scheduler DB 位于调用方显式 `stateRoot`，只保存严格投影后的 observation ID、digest、scope、provenance，以及 lease/attempt/checkpoint/净化 telemetry；额外正文或运行时字段在持久化边界拒绝。

同步 extract 默认 1.5 秒软 deadline。显式 AbortSignal 取消不排队；内部 timeout 可由宿主注入的 deferred enqueue 接口转后台。commit 开始后不尝试中断本地原子事务。

Pi adapter 不在 prompt hook 中调用模型。它持久化 expansion 前用户原文，但只在 active branch 上的稳定 user entry 与最终 `stop` assistant 配对后，原子投递独立 extract job；失败、中断、截断、assistant、thinking、tool output、streaming steer/follow-up 和 extension-originated 输入均排除。worker 以 `(session_id, scope)` 保序，过期 lease 可回收，旧 worker 必须通过 token+generation fencing 才能提交。自动来源固定为 `user_statement`；疑似更正或遗忘的表达不自动采集，必须由未来显式治理入口处理。每个 job 的模型 disclosure scope 被收窄到 observation scope，禁止模型自行把项目陈述提升为 global。Core 中已提交的同 source receipt 会在重放时直接返回 idempotent，覆盖“Canonical commit 成功但 outbox ack 前崩溃”的窗口。
