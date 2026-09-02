# 00 · 概览与边界

**Memory Writer Benchmark（MWB）v0.1 — Specification Release**
状态：规范冻结候选（Release Candidate）。数据集（worlds）与排行榜不在本版本范围内。

## 0.1 规范用语

本规范使用 RFC 2119 语义：**MUST / MUST NOT** 为硬性要求，违反即不符合 MWB v0.1；**SHOULD / SHOULD NOT** 为强烈建议，偏离必须在报告中说明；**MAY** 为可选。所有 schema 文件（`schema/*.v1.schema.json`）是规范的一部分，与正文冲突时以 schema 为准。

## 0.2 研究问题

> 在相同历史、相同 Reader、关闭查询时检索的条件下，哪个 Memory Writer 产生的持久记忆制品，最能支持 Writer 从未见过的、跨领域的未来任务；同时不把过时、错误、局部或无关的信息带入这些任务？

形式化：

\[
Z \xrightarrow{G} H,\qquad M_i = W_i(H;\theta_i),\qquad \tilde M_i = S(M_i),\qquad Y_{i,r,t} = A_r(C,\ \tilde M_i,\ T_t)
\]

- \(Z\)：隐藏世界状态（六类 state atom，见 `02`）；
- \(G\)：把 \(Z\) 渲染成自然交互历史 \(H\) 的生成器（v0.1 为人工/模板）；
- \(W_i\)：被测 Writer，\(\theta_i\) 由 WriterCard 完整固定；
- \(S\)：确定性、无损、与任务无关的序列化器（`mwb-canonical-text/1`）；
- \(A_r\)：统一 Reader；\(T_t\)：从私有任务分布中在记忆冻结**之后**采样的未来任务。

## 0.3 本 benchmark 测什么、不测什么

| 测量 | 不测量 |
|---|---|
| Writer 制品在 **Retrieval-Free Full-Artifact Exposure** 下对未来任务的效用 | 任何系统自带 retrieval / rerank / query rewrite 的端到端效果 |
| 写入-遗忘平衡（功能性遗忘，不是物理删除） | 记忆文本与某个 Gold Memory 的相似度 |
| 由共享潜变量支撑的跨领域正迁移与负迁移 | Writer 在 on-policy 实时交互中改变用户轨迹的能力 |
| 制品的容量效率（Natural Output + 4K/16K 预算轨） | 单一综合总分下的"谁最好" |

**结果解释范围（MUST 随结果一并陈述）：**

> Writer *W* 在 Reader *R*、暴露协议 `mwb-canonical-text/1`、预算 *B*、后端条件 *(native | matched)*、数据集版本 *D* 下取得如下指标向量。

不得表述为"Writer *W* 在所有场景下更好"。参与比较的每个 Writer 由 `writer-card.v1` 精确到 commit、组件面、写入模型与配置；系统名称本身不是 Writer。

## 0.4 四条设计原则

1. **Causal Identifiability**：同一 world、同一 task、同一 Reader，只改变 Writer。任何会随 Writer 变化的环节（序列化、prompt、工具、Judge）MUST 固定。
2. **Architecture Agnostic**：不要求统一为 facts / summary / ADD-UPDATE-DELETE。导出的是各系统原生 read path 可见的持久语义制品。
3. **Utility First, Audit Second**：排名依据是未来任务行为；制品审计只用于解释失败模式，不进入主指标。
4. **Distributional Evaluation**：Writer 面对的是一个隐藏的未来任务分布，而不是一个固定任务；同一历史 MUST 对应 ≥ 4 个不同类型的任务。

## 0.5 术语

| 术语 | 定义 |
|---|---|
| World | 一个隐藏状态集合 \(Z\) + 一段渲染历史 \(H\) + 一组未来任务 + 若干变体（twin） |
| State atom | \(Z\) 中一条带 scope / 时间窗 / 认知状态 / 归属 / 可迁移性标注的真值陈述 |
| History event | Writer 可见的最小单元：一次用户发言、助手回复、工具输出或文件变更 |
| Writer | 一个精确的写入实现（WriterCard），消费 \(H\) 产出 \(M\) |
| Quiescence | Writer 完成所有文档化的 flush / consolidation 且无 pending job 的稳态 |
| Artifact | quiescence 后导出的、经 MAI 过滤的原生持久语义记忆（ArtifactManifest） |
| Canonical rendering | Artifact 的确定性文本化，Reader 实际看到的内容 |
| Reader | 固定快照、固定 prompt、固定工具的下游 Agent；不知道 Writer 身份 |
| Task | 一个 TaskSpec：prompt + 必需/禁止/无关状态 + 评分器 + 认证要求 |
| Twin | 与基线 world 仅差一个 pivot 状态（counterfactual）或仅差噪声（noise）的历史变体 |
| Certification | 任务进入正式集合前必须通过的 memory-dependence 检验 |
| Profile Card | 一个 Writer 的完整指标向量报告；v0.1 不定义综合总分 |

## 0.6 文档地图

| 文件 | 内容 |
|---|---|
| `spec/01-protocol.md` | 准入、重放、稳态、导出、序列化、Reader、基线构造 |
| `spec/02-world-and-task-design.md` | 隐藏状态、历史生成、任务类型与配比、四领域、跨域规则、反作弊、认证 |
| `spec/03-evaluation.md` | 单任务评分、指标定义与边界条件、因果检验、制品审计、预算轨、统计、Judge、报告格式 |
| `spec/04-release-and-governance.md` | 版本、数据切分、提交与复现要求、校准对象状态、已知限制、路线图 |
| `schema/` | 7 个 JSON Schema（draft 2020-12） |
| `examples/latticenote/` | 完整参考 world（19 states / 67 events / 6 tasks / 2 variants） |
| `tools/validate.mjs` | world 级 schema + 交叉一致性校验、oracle 渲染、变体渲染 |
| `templates/`、`checklists/` | WriterCard / TaskSpec / Profile Card 模板；发布与认证清单 |
