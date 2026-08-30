# 检索与远程候选

本地检索继续使用结构化过滤与 SQLite FTS5/BM25；没有 embedding、向量或图检索。默认当前视图隐藏 archive、superseded、expired 和 deleted。

MemoryManager 通过 Core 查询 facade 获取至多 20 条当前候选，并要求 knowledge/store revision 与 repository info 一致；不一致时完整重读一次。外发候选仅含 fact token、statement、kind、scope、priority、validity 和 tags，不含文件路径、repository ID、YAML、authority 或稳定用户标识。

索引无法验证时不猜测 duplicate、add 或 target rebase。模型只能引用请求内 candidate fact ID 和临时 evidence ref。
