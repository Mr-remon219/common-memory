# Memory Writer Benchmark (MWB) — Spec v0.1.0

**Writer-centric, retrieval-free evaluation of long-term memory writers.**
状态：Specification Release（规范发布）。本版本发布协议、schema、指标与一个完整参考 world；不发布排行榜，不对任何具体系统做质量结论。

## 它测什么

> 不同 Memory Writer 在经历**完全相同的历史**后，谁能把过去压缩成最适合**未知未来任务**使用的长期状态——该迁移的能迁移，不该迁移的不污染，过时的不再生效。

```text
Same Hidden World → Same History → Different Writers → Frozen Native Artifacts
→ No Native Retrieval → Lossless Full-Artifact Exposure → Same Reader
→ Hidden Multi-Domain Future Tasks → Behavioral Utility + Artifact Audit
```

它**不**测：系统自带 retrieval 的端到端效果、记忆文本与人工 Gold Memory 的相似度、on-policy 交互中的表现。完整边界见 `spec/00-overview.md` §0.3。

## v0.1 包含什么

| 路径 | 内容 |
|---|---|
| `spec/00-overview.md` | 研究问题、边界、术语、结果解释范围 |
| `spec/01-protocol.md` | 准入 → 重放 → 稳态 → 导出（MAI）→ 渲染（`mwb-canonical-text/1`）→ Reader → 8 个基线的精确构造 |
| `spec/02-world-and-task-design.md` | 六类隐藏状态、历史生成要求、6 种任务类型与配比、四领域评分指引、跨域合法性、反作弊、认证条件 C1–C5 / N1–N2 / T1–T3 |
| `spec/03-evaluation.md` | 单任务得分 \(s=\mathrm{clamp}(\sum w_kc_k-\sum w_jv_j)\)、MG / NOR / Transfer Matrix / NTP / U(B)、CS / CI、制品审计、预算轨、Judge、统计、Profile Card |
| `spec/04-release-and-governance.md` | 版本策略、数据切分、提交与复现要求、校准候选状态、Common Memory 政策、已知限制、路线图 |
| `schema/*.v1.schema.json` | StateAtom、WorldSpec、HistoryEvents、HistoryLabels、TaskSpec、WriterCard、ArtifactManifest、RunRecord |
| `examples/latticenote/` | 参考 world：19 states / 12 sessions / 67 events / 6 tasks / 2 variants / hidden tests / 冻结 Reader prompt |
| `tools/validate.mjs` | schema + 交叉一致性校验；`--oracle` 渲染 oracle-minimal 记忆；`--variant` 渲染孪生历史；`--writer-card` 校验 WriterCard |
| `templates/` | WriterCard 示例、TaskSpec 模板、Profile Card 模板、两条基线的逐字定义 |
| `checklists/` | 发布清单、任务认证清单 |
| `CHANGELOG.md` | 从研究报告 v0.3 到 Spec v0.1.0 的全部修正与理由 |

## 快速开始

```bash
# 在仓库根目录（依赖 ajv / ajv-formats / yaml 从上层 node_modules 解析）
cd benchmark/memory-writer-benchmark
node tools/validate.mjs examples/latticenote
node tools/validate.mjs examples/latticenote --oracle task.coding.import_conflicts
node tools/validate.mjs examples/latticenote --variant variant.cf_explanation_style > /tmp/cf-events.yaml
node tools/validate.mjs examples/latticenote --writer-card templates/writer-card.example.yaml
```

## 三种参与方式

**Writer 作者**：填写 `templates/writer-card.example.yaml` → 实现无损导出适配器（`schema/artifact-manifest.v1`）→ 通过 `spec/01` §1.2 六项准入 → 在 `public_dev` world 上按 §1.3–1.8 自测 → 用 `templates/profile-card.md` 报告。

**World 作者**：先写 `states.yaml`（六类齐备），再渲染 `history/events.yaml`，最后从状态派生 ≥ 4 个任务（配比见 `spec/02` §2.3）→ `tools/validate.mjs` 通过 → 按 `checklists/task-certification-checklist.md` 认证。

**评测方**：运行 8 个基线 + 认证 → 运行 Writer → 产出 `run-record.v1` → 按 `spec/03` §3.9 统计 → Profile Card。任何数字都必须能仅凭 RunRecord 复算。

## 诚实性声明

- 结论只在所声明的 Reader、暴露协议、预算、后端条件、数据集版本下成立；这是实验边界，不是缺陷。
- `spec/04` §4.6 列出的系统是**候选校准对象**，状态一律"准入待验证"；本规范未对它们做任何测量。
- 参考 world 是公开的，因此其任务标记为 `waived_reference_only`，不得用于排名。
- 认证阈值（δ=0.20, δ_a=0.15, ε=0.10）与预算点（4K / 16K）是工程预设，需 Pilot 数据检验。

## 与 Common Memory 的关系

本目录位于 Common Memory 仓库内，但与 `src/` 无代码依赖，不进入 npm 包。Common Memory 不参与 v0.1 的设计校准与 Pilot；benchmark 冻结后，其多个 Writer 变体才作为被测对象参赛（`spec/04` §4.7）。

## 来源

本规范由三份研究文稿整理、修正并规范化而来：`Memory Writer Benchmark — Shared Understanding`（研究目标）、`Memory_Writer_Benchmark_优化研究报告_v0.3`、`Memory_Writer_Benchmark_MVP规范_v0.3`。修正清单见 `CHANGELOG.md`。
