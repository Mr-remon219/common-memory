# 交付与验收

本版本直接更新未发布的 Canonical v1 schema；旧预发布数据根需重建，不提供 migrator。

验收顺序：typecheck、boundary lint、contracts/revision/governance/transaction/memory-manager tests、全测试、build、consumer、remote contract、pack dry-run、diff check、staged-empty。真实 OpenAI smoke 可选，只从 `OPENAI_API_KEY`/`OPENAI_MODEL` 读取。

本切片已加入 Pi 原生 `memory_recall` 与 settled-turn 异步 extract adapter；它们直接复用共享 Runtime，不经过 MCP。

仍属非目标：自动 recall 注入、本地模型、其他 provider/OpenAI-compatible endpoint、OpenAI SDK、MCP、其他 Agent、完整 session ledger/compaction UI、embedding/vector/graph、Git remote、hard delete、审计 GC、schema epoch/migrator、provider 撤回。
