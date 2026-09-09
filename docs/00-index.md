# Common Memory V2 文档

- [会话接入与验收边界](session-integration.md)
- [实施规格与架构决定](03-target-architecture.md)
- [Init v0.1：跨 Agent 记忆迁移与复用 — 研究、设计与计划](init-v0.1-design.md)
- [Init v0.1：验收记录](init-v0.1-verification.md)
- [旧测试替换边界](v2-replacement-test-map.md)
- [合成轨迹与真实模型评测边界](v2-evaluation.md)
- [实现性能优化](v2-performance.md)
- [调度机制消融实验](v2-ablation.md)
- [交付验证与独立审查](v2-verification.md)
- [使用与配置](../README.md)

Write/current-state 之外，Init v0.1 增加了三条受授权约束的接口：Init（其他 Agent 提交自述理解）、Markdown 导入（`common-memory import`，文件经输入预处理成为 `document_import` 观察）——两者都仍由同一个 Writer 决定写入——与只读披露（MCP `memory_read`、Pi 系统提示注入、CLI `show`，按 `disclosure.allowedScopes` 与启动上下文返回当前 Markdown 原文）。旧 YAML Fact、Proposal、Review、Recall/FTS、Undo 文档及资产已随实现删除，不作为 V2 规范或兼容保证；本版也不引入检索、索引或排序。
