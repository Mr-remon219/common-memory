# 04 · 发布与治理

## 4.1 v0.1 的定位：Specification Release

v0.1 冻结的是**协议、schema、指标定义与参考实现**，不是数据集，也不是排行榜。它使任何团队都能：

- 按 `02` 独立构造合格 world 并用 `tools/validate.mjs` 校验；
- 按 `01` 为自己的 Writer 编写 WriterCard 与导出适配器；
- 按 `03` 在公开 dev world 上自测并得到可比的 Profile Card。

v0.1 **不包含**：私有测试集、任何 Writer 的分数、对任何具体系统的结论。

## 4.2 版本策略

三个独立版本号：

| 对象 | 规则 | v0.1 当前值 |
|---|---|---|
| Spec（协议 + schema + 指标） | semver；schema `additionalProperties:false` 下新增必填字段为 major；阈值修订为 minor；文字澄清为 patch | `0.1.0` |
| Dataset（world 集合） | `<split>-<YYYY.MM>[-r<n>]`，private_test 每次轮换递增 | `reference-2026.09`（仅 LatticeNote） |
| Harness（运行器实现） | 实现者自定，但 RunRecord MUST 记录 `benchmark_version` 与 `dataset_version` | — |

任何改变 `mwb-canonical-text/1` 渲染、`o200k_base` 计量、认证阈值或 \(s\) 公式的修改都是 **breaking**，需 major 递增并作废旧结果的可比性。

**术语对齐**：本 benchmark 之前的研究文稿版本号为 v0.1–v0.3（"Shared Understanding" → "优化研究报告 v0.3" / "MVP 规范 v0.3"）。那是研究文稿的迭代号；本文件系起点为 **Benchmark Spec v0.1.0**。`CHANGELOG.md` 记录从研究报告 v0.3 到 Spec v0.1.0 的全部修正。

## 4.3 数据切分

| split | 可见性 | 用途 | 规模目标 |
|---|---|---|---|
| `reference` | 公开 | 解释协议、验证 harness | 1 world（LatticeNote） |
| `public_dev` | 公开 | Writer 作者自测、社区复现 | Sanity Pilot：8 worlds × 4 tasks |
| `private_test` | 保密；仅评测方持有 | 正式 Profile Card | MVP：24 worlds × 4 tasks；每 6 个月轮换 ≥ 1/3 |

切分 MUST 在 **world-family 级**（同一模板 / 同一虚构组织的 world 不得跨 split），而不是实例级随机切分。

## 4.4 规模路线

| 阶段 | worlds | tasks | budgets | readers | subjects | 目的 |
|---|---|---|---|---|---|---|
| Sanity Pilot | 8（4 领域 × 2） | 32 | natural + 1 | 1 primary | 3 外部 Writer + 8 基线 | 验证认证通过率、区分度、导出稳定性、Judge 可控性 |
| MVP | 24（每领域 6） | 96 | natural + 4K + 16K | 1 primary + 25% robustness | 5–7 Writer + 基线 | 首份正式 Profile Card 集 |
| Full | 60+ | 300+ | 3 | 2 families | — | on-policy 扩展、轮换私有集、专家校验子集 |

Pilot 验收（工程预设，非自然常数）：≥ 80% 任务通过认证；oracle 对 no_memory 的提升 95% CI 不跨 0；irrelevant_only 不显著高于 no_memory；full_transcript 不在所有预算、所有任务上统治；≥ 3 种可解释 failure profile；Primary / Robustness Reader 主要结论方向一致；每个 Writer 的身份、版本、模型、配置可完整复现。

## 4.5 提交与复现要求

一份可被接受的结果提交 MUST 包含：

1. `writer-card.v1`（含 admission 证据、导出适配器版本与 config_hash）；
2. 每个 (world, variant, seed) 的 `artifact-manifest.v1` 与 canonical rendering 全文；
3. 全部 `run-record.v1`（含基线运行；oracle 类运行由评测方生成）；
4. Reader prompt 文件及其 sha256；
5. Judge 配置、双 Judge 一致率、人工校准子集 \(\kappa\)；
6. Profile Card（`templates/profile-card.md`）。

评测方 MUST 能仅凭 1–5 复算 Profile Card 的所有数字。

## 4.6 校准对象的当前状态

下列系统是 v0.3 研究阶段列出的**候选校准对象**。在 v0.1 中它们的状态一律为"准入待验证"；本规范不对其中任何一个做出质量陈述。

| 候选 Writer（须精确到实现） | 组件面 | 预计准入类别 | 特别注意 |
|---|---|---|---|
| Hermes Agent built-in memory | 内置 curated memory 文件 | replay_adapted（待验证） | 外部 provider（Mem0 / Hindsight 等）各自是独立 Writer |
| OpenClaw native memory core | tiered files + 异步 consolidation 输出 | replay_adapted（待验证） | 多 tier、异步；quiescence 关键 |
| GBrain fact extraction lane | atomic facts + kind/entity/confidence/notability | replay_native（待验证） | 仅此 lane，不代表 GBrain 全部能力 |
| `samfoy/pi-memory` @ commit | semantic facts / lessons / events DB 记录 | replay_adapted（待验证） | `agent_end` 收集、`session_shutdown` 合并 |
| Mem0 OSS @ version | 抽取记忆 + metadata/entity links | replay_native（待验证） | ADD-only 版本会在无检索条件下暴露旧事实并存 —— 这是被测取舍，不是统计错误 |
| Codex local memories | 两阶段 extraction / consolidation 制品 | gray_box / replay_adapted（待验证） | 异步 job 状态必须检查；空制品 ≠ 低质量 |
| A-MEM | 公开学术基线 | replay_native | 用作学术可复现锚点 |

无法通过准入的候选 MUST 记为 `rejected`，不得改造。

## 4.7 Common Memory 政策

Common Memory（本仓库其余部分）**不参与** v0.1 的设计校准，也不作为 Pilot 的 Writer。流程固定为：

```text
外部系统 + 基线 校准 benchmark
   → 修订并冻结 task generator / metrics / private_test
   → 再并行实现 Common Memory Writer variants (CM_A, CM_B, ...)
   → 盲测比较不同设计路线
```

在 benchmark 冻结之前，Common Memory 的任何变体 MUST NOT 用于 task tuning。`benchmark/` 目录与 `src/` 没有代码依赖，且不进入 npm 包。

## 4.8 已知限制（MUST 随结果一并声明）

1. **不是纯 Writer 智能分数**：无法消除 representation × Reader 交互与写入模型能力的影响；结论限定于所声明的 Reader / 协议 / 预算 / 后端条件。
2. **Off-policy 历史**：静态历史下 Writer 的早期输出不改变用户后续行为；on-policy 排名可能不同（Phase 2）。
3. **合成 world 的外部效度**：与真实用户历史的相关性尚未验证。
4. **认证阈值与预算点为预设**：\(\delta=0.20,\ \delta_a=0.15,\ \epsilon=0.10\)、4K / 16K 需 Pilot 数据支持。
5. **制品审计有自动抽取误差**：审计层仅作诊断。
6. **Reader 中性性未知**：哪一个 Reader 对多种 representation 最中性，是实验问题。
7. **单语言**：v0.1 world 逐个声明 `language`；跨语言排名是否变化未验证。
8. **导出边界需上游认可**：`acknowledged_by_upstream=false` 的结果 SHOULD 标注。

## 4.9 路线图

| 版本 | 内容 |
|---|---|
| 0.1.x | 文字澄清；validator 增强；`public_dev` Sanity 8 worlds 发布 |
| 0.2 | Pilot 后修订阈值与预算点；world 模板生成器；审计层自动抽取器规范；Judge 校准集 |
| 0.3 | MVP 24 worlds；首批 Profile Card；private_test 轮换机制上线 |
| 1.0 | on-policy interactive track；Native End-to-End track（独立研究）；多语言 |
