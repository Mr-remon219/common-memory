# 问题与原则

Common Memory 保存可追溯、可修正的长期事实，同时允许远程模型协助抽取与治理。远程模型是不可信建议者，不是 reviewer 或写入者。

原则：

1. Canonical YAML 是唯一权威；索引和 scheduler DB 都可丢弃重建。
2. 模型不可提供可信 ID、时间、source、reviewer、authority、路径或 revision。
3. 外发必须显式启用并通过 scope/provenance/byte cap 与敏感扫描；扫描对象与发送对象逐字相同。
4. 自动 action 只接受 high confidence；不能创建 core，consolidate 不能目标化 core。
5. 自动批次一次事务写入 Proposal、approved Review 和 Fact mutation；任一 action 失败则全包拒绝。
6. 幂等恢复先于 stale guard；首次 stale 可重新分析一次，不自动 rebase target。
7. 远程失败零 Canonical 污染；取消在 commit 前保证无写。
8. API key、秘密、正文、原始 provider body/refusal 不落盘、不入日志。
9. Undo 通过追加补偿恢复语义，永不 hard delete 或伪造旧 provenance。
10. 不扩大到本地模型、其他 provider、MCP/Pi/TUI 或向量检索。
