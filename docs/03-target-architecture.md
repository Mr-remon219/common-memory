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
```

网络、timer 和 scheduler 永不运行在 Core lock 内。Provider 不导入 repository/layout/transaction；Core 不导入 provider 或 scheduler。Scheduler DB 位于调用方显式 `stateRoot`，只保存严格投影后的 observation ID、digest、scope、provenance，以及 lease/attempt/checkpoint/净化 telemetry；额外正文或运行时字段在持久化边界拒绝。

同步 extract 默认 1.5 秒软 deadline。显式 AbortSignal 取消不排队；内部 timeout 可由宿主注入的 deferred enqueue 接口转后台。commit 开始后不尝试中断本地原子事务。
