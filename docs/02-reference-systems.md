# 参考系统与取舍

本项目保留 Git-friendly 文件级权威记录、不可变治理审计与 SQLite FTS5 派生检索。远程分析仅借鉴“模型建议 + 本地确定性提交”的形态，不继承 provider 持久化、Agent 自审或向量数据库。

生产 provider 固定为 OpenAI Responses REST endpoint，使用 Node 24 原生 fetch；provider-neutral `MemoryModelPort` 只隔离 Core 与 wire protocol，不承诺第二 provider。Structured Outputs wire schema 使用官方支持子集，本地 AJV 后再验证唯一性、长度、echo、membership、预算和跨字段关系。
