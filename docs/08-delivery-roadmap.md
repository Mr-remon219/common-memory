# 交付与验收

本版本直接更新未发布的 Canonical v1 schema；旧预发布数据根需重建，不提供 migrator。

验收顺序：typecheck、boundary lint、contracts/revision/governance/transaction/memory-manager tests、全测试、build、consumer、remote contract、pack dry-run、diff check、staged-empty。真实 OpenAI smoke 可选，只从 `OPENAI_API_KEY`/`OPENAI_MODEL` 读取。

非目标：本地模型、其他 provider/OpenAI-compatible endpoint、OpenAI SDK、MCP、Pi、CLI/TUI、embedding/vector/graph、Git remote、hard delete、审计 GC、schema epoch/migrator、provider 撤回。
