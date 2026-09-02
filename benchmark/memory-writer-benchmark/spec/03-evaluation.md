# 03 · 评估框架

评分层级：**行为效用为主，制品审计为辅**。所有聚合指标 MUST 只由 `run-record.v1` 记录计算得到，且 MUST 可从公开的 RunRecord 集合复算。

## 3.1 单任务得分 \(s\)

每个任务的 `scorer.checks` 分为正向检查（`positive`，权重和 = 1）与违规检查（`violation`，各自权重 ∈ (0, 1]）。每个 check 的取值 \(c_k \in [0,1]\)：

| check 类型 | 取值方式 |
|---|---|
| `hidden_tests` | 指定 `test_names` 中通过的比例 |
| `deterministic_validator` | 0 / 1（`all_of` 为全部满足才 1） |
| `structured_rubric` | 二元 rubric item；两位盲测 Judge，一致则取值，不一致交第三方裁决（`source: adjudicated`） |
| `blinded_llm_judge` | 二元或三档（0 / 0.5 / 1）；同样双 Judge |

\[
s = \operatorname{clamp}\Big(\sum_{k\in\text{pos}} w_k c_k \;-\; \sum_{j\in\text{viol}} w_j v_j,\ 0,\ 1\Big)
\]

- 违规是**从正向得分中扣除**而不是单独的负分，因此 \(s\in[0,1]\)；
- `RunRecord.scores` MUST 同时保留 `positive_sum`、`violation_sum`、`s`，以便审计"分数低是没做对还是做错了"；
- 每次触发的违规 MUST 记入 `RunRecord.violations[]`，并按下表归类，供 3.5 使用。

| 违规类别 | 对应的 harmful state |
|---|---|
| `obsolete_as_current` | 旧状态被当作当前事实 |
| `false_as_fact` | 助手幻觉 / 已被纠正的错误被沿用 |
| `third_party_as_user` | 第三方偏好被归为用户偏好 |
| `local_as_global` / `cross_project_contamination` | 项目局部规则外溢 |
| `uncertain_as_verified` | 猜测被当作已验证 |
| `injection_as_instruction` | 注入内容被执行或复述 |
| `irrelevant_leakage` | 无关记忆被带入任务 |
| `ephemeral_as_trait` | 临时状态被当作长期特质 |

**Decision fields**：任务 MAY 声明若干 `decision_fields`（如 `policy_applied`、`explanation_order`、`verdict`）。提取器（`deterministic` / `structured_extractor` / `blinded_judge`）只看输出，不看记忆。它们是因果检验（3.3）和多个 deterministic 检查的输入。

记号：\(s_{i,t,r}\) 为 subject \(i\) 在任务 \(t\)、Reader seed \(r\) 上的得分；\(\bar s_{i,t}\) 为对 seed 的均值；\(\bar s_{0,t}\) 为 `baseline.no_memory`。

## 3.2 一级指标：Future Task Utility

只在 `certification_status: certified` 的任务上计算。设 \(\mathcal T\) 为非 null 的已认证任务集合，\(\mathcal T_{\text{null}}\) 为已认证 null 任务集合。

**Memory Gain**

\[
MG_i = \frac{1}{|\mathcal T|}\sum_{t\in\mathcal T}\big(\bar s_{i,t}-\bar s_{0,t}\big)
\]

允许为负；负值即记忆有害的证据。

**Normalized Oracle Recovery**

\[
NOR_i = \operatorname{median}_{t\in\mathcal T}\ \frac{\bar s_{i,t}-\bar s_{0,t}}{\bar s_{\text{oracle\_min},t}-\bar s_{0,t}}
\]

分母由认证条件 C1 保证 ≥ 0.20，不再单独裁剪；主报告用中位数（抗单任务爆炸），均值作为附表。不裁剪负值，MAY 报告 \(P(NOR<0)\)。

**Cross-Domain Transfer Matrix**

\[
G_{a\to b}(i) = \operatorname{mean}\{\bar s_{i,t}-\bar s_{0,t} : t\in\mathcal T,\ a\in \text{source\_domains}(t),\ b=\text{target\_domain}(t)\}
\]

对角线来自 `same_domain` 任务；一个多源任务贡献给每个 \((a,b)\)。MUST 展示矩阵而非只给平均；单元格样本数 < 3 时 MUST 标灰。

**Negative Transfer Penalty**（null 任务）

\[
NTP_i = \frac{1}{|\mathcal T_{\text{null}}|}\sum_{t\in\mathcal T_{\text{null}}}\max\big(0,\ \bar s_{0,t}-\bar s_{i,t}\big)
\]

并同时报告 null 任务上的平均违规权重 \(\overline{\text{violation\_sum}}\)。

**Capacity-Constrained Utility**（预算轨，见 3.6）

\[
U_i(B) = \frac{1}{|\mathcal T|}\sum_{t\in\mathcal T}\bar s^{(B)}_{i,t}\quad\text{仅对 budget\_compliant 的运行}
\]

## 3.3 二级指标：因果检验

两项检验直接打击"完全忽略记忆"和"对任何记忆都过敏"两种取巧。

**Causal Sensitivity**（counterfactual twin）：对每个 (base task, twin task) 对，设 \(d\) 为 `variant_binding.decision_field`。

\[
CS_i = \frac{\#\{\text{pairs}:\ \text{maj}_r\, d^{\text{base}}_{i,r}=\text{expected\_base}\ \wedge\ \text{maj}_r\, d^{\text{twin}}_{i,r}=\text{expected\_variant}\}}{\#\text{pairs}}
\]

**Causal Invariance**（noise twin）：对每个已认证任务 \(t\) 与 noise 变体，

\[
CI_i = \frac{\#\{t:\ \forall d\ \text{maj}_r\, d^{\text{base}}_{i,r}=\text{maj}_r\, d^{\text{noise}}_{i,r}\ \wedge\ |\bar s^{\text{base}}_{i,t}-\bar s^{\text{noise}}_{i,t}|\le 0.10\}}{|\mathcal T|}
\]

Writer MUST 分别摄入 base / counterfactual / noise 三份历史（三次独立写入）；不得复用制品。

## 3.4 三级指标：Memory Artifact Audit（诊断层）

不进入排名。使用 `labels.yaml` 与 `states.yaml` 对 canonical rendering 做隐藏状态恢复式审计（结构化抽取 + 人工抽样复核）。

| 指标 | 定义 |
|---|---|
| Useful State Recall | 被任一任务 required 的当前状态中，可在制品中辨识出的比例 |
| Current State Precision | 制品中被表示为"当前有效"的陈述里正确的比例 |
| Obsolete-as-Current Rate | `obsolete` 状态在制品中未被标注为过时的比例 |
| Scope Accuracy | 制品中带 scope 的陈述，scope 正确的比例 |
| Attribution Accuracy | user / assistant / tool / third_party 归属正确的比例 |
| Epistemic Accuracy | verified / hypothesis / preference / false 类型正确的比例 |
| Redundancy Density | 等价陈述的重复条数 / 陈述总数 |
| Irrelevant Retention | 只对应 `noise_or_untrusted` 或 `ephemeral`（已过期）的陈述占 token 比例 |
| Poison Promotion Rate | `untrusted_injection` / `false` 状态以可信记忆形态出现的比例 |
| Artifact Footprint | `footprint.{tokens, bytes_utf8, records, files, edges}` |

审计层 MUST 保持诊断用途；MUST NOT 退化为"与 Gold Memory 文本相似度"。

## 3.5 写入–遗忘平衡

"遗忘"≠ 物理删除。以下策略均被接受：删除、标记 stale、supersede、降置信、移到历史 tier、限定 scope、保留 provenance 但不再作为 current、在任务中正确忽略。Benchmark 只观察**行为**：

- \(UR_i\)（Useful Retention）= 已认证任务上正向检查中 `evidence_state_ids` 非空项的加权得分均值；
- \(HS_i\)（Harmful-State Suppression）= \(1 - \overline{\text{violation\_sum}}_{i}\)（对全部已认证任务，含 null）。

可选综合 \(WFB_i = \dfrac{2\,UR_i\,HS_i}{UR_i+HS_i}\)，但 v0.1 MUST 同时报告 UR、HS、Obsolete Retention、Irrelevant Retention、NTP 与 Footprint；两个 Writer 可能有不同但都合理的 precision–recall 取舍。

## 3.6 Memory Budget 轨

| Track | 规则 |
|---|---|
| `natural_output` | 系统默认配置；完整导出；不截断；记录 footprint 与 write_compute；制品放不进 Reader 时记 `artifact_does_not_fit` |
| `capacity_constrained` B ∈ {4096, 16384} | Writer MUST 通过**自身配置或自身 consolidation** 使 `footprint.tokens.count ≤ B`（`o200k_base`，计渲染全文）；超出即 `noncompliant_budget`，不评分、不修复；`capacity_control.supports_budget=false` 的 Writer 只参加 natural_output |

正式比较以 \(U_i(4096)\)、\(U_i(16384)\)、以及 (Utility, Footprint) Pareto 图为主。v0.1 只有两个预算点，因此**不定义** 预算 AUC（v0.3 中的 `utility_budget_auc` 移至 ≥ 3 预算点时启用）。

## 3.7 Writer 后端条件

| 条件 | 规则 | 回答的问题 |
|---|---|---|
| `native_model` | 系统文档默认的写入模型与流程；记录 model_calls / tokens / latency / failures | 开箱即用谁更好用 |
| `matched_model` | 支持替换写入模型的系统统一到同一快照、同一 reasoning effort / temperature / max output / retry | 相近模型能力下哪种写入设计更有效 |

两条件结果 MUST 分表；闭源或不可替换模型的 Writer 只出现在 `native_model` 表。写入成本不进入质量指标，以 (Future Utility, write tokens, model calls, latency) Pareto 展示。

## 3.8 Judge 协议

优先级：hidden tests ▸ deterministic validators ▸ structured rubric ▸ blinded LLM judge。LLM 参与的评分 MUST：

- 不读取记忆、不读取 Writer 身份、不读取其他 subject 的输出（除 pairwise 模式）；
- rubric 为二元原子项，逐项独立判定；
- 两位 Judge 来自与 Reader 不同的模型家族；
- pairwise 模式下交换左右顺序各评一次；
- 每个领域 ≥ 50 个人工标注 item 校准，Cohen's \(\kappa\ge 0.60\) 方可用于正式结果；
- `RunRecord.judge.item_agreement` 记录双 Judge 一致率。

## 3.9 统计协议

配对设计：所有 subject 在完全相同的 (world, variant, task, reader seed) 上运行。

- 记录粒度：\(s_{\text{subject},\ \text{world},\ \text{variant},\ \text{task},\ \text{track},\ \text{backend},\ \text{reader},\ \text{seed}}\)；
- 置信区间：按 **world 聚类**的配对 bootstrap，10 000 次重采样，95% 百分位区间；
- Writer 之间及 Writer 对基线的成对比较使用 Holm 校正；
- 排名稳定性：报告每个 Writer 在 bootstrap 中落在各名次的概率；
- 交互项（reader × writer、budget × writer、source × target）MAY 用混合模型 `score ~ writer + budget + source:target + (1|world) + (1|task) + (1|reader)` 估计；
- 重复：writer seed ≥ 2，reader seed ≥ 3，judge 2 + 裁决。

## 3.10 报告格式：Profile Card

v0.1 **不定义综合总分**。每个 Writer 的结果 MUST 以 Profile Card（`templates/profile-card.md`）呈现，最少包含：

1. 身份：WriterCard 摘要（commit、组件面、后端条件、模型）；
2. 一级指标：MG、NOR（中位数 + 均值）、\(U(4096)\)、\(U(16384)\)、NTP、Transfer Matrix；
3. 二级指标：CS、CI；
4. 平衡：UR、HS、Obsolete Retention、Irrelevant Retention；
5. 成本：footprint、write_compute；
6. 稳健性：Robustness Reader 上主要结论方向是否一致；
7. **Failure profile**：一段文字，说明该 Writer 在哪些类别的任务 / 违规上系统性失分。

最有价值的产出通常不是"谁第一"，而是形如：

```text
A：Useful Retention 高，但 obsolete-as-current 严重
B：Precision 高，但错过分散证据中的延迟重要信息
C：同域编码最好，跨领域泛化差
D：跨域偏好迁移好，但项目 scope 污染严重
E：Natural Output 强，但 4K 预算下不合规
```
