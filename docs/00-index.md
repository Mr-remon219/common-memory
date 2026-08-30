# Common Memory 文档索引

当前版本实现本地 Canonical Core 与 OpenAI Responses 原生 fetch 的自主记忆管理。模型只产出 MemoryAnalysis v1 建议；本地 policy、revision guard、nominal authority 和原子事务拥有最终权力。

- [01-problem-and-principles.md](01-problem-and-principles.md)：目标、信任与安全原则
- [02-reference-systems.md](02-reference-systems.md)：外部系统借鉴边界
- [03-target-architecture.md](03-target-architecture.md)：Core、MemoryManager、provider、scheduler 边界
- [04-memory-model.md](04-memory-model.md)：Canonical、批次审计、revision、undo
- [05-memory-manager-api.md](05-memory-manager-api.md)：公开 API 与 disclosure
- [06-retrieval-and-context.md](06-retrieval-and-context.md)：FTS 与远程候选投影
- [07-openai-responses-adapter.md](07-openai-responses-adapter.md)：固定 Responses REST contract
- [08-delivery-roadmap.md](08-delivery-roadmap.md)：验收与非目标

MemoryAnalysis wire schema 随包发布，但 Canonical schema bundle 永远只包含 repository/fact/proposal/review 四项。
