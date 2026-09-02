# CHANGELOG

## Spec v0.1.0 — 2026-09-02

首个规范发布。基线是研究文稿《优化研究报告 v0.3》与《MVP 规范 v0.3》（下称"v0.3 报告"）。研究文稿的 v0.1–v0.3 是文稿迭代号；本文件系从 **Spec v0.1.0** 起独立计数（`spec/04` §4.2）。

### 保留自 v0.3 报告的核心判断（未改动）

- 只测 Writer，关闭 native retrieval，全量制品暴露；"Identity Retrieval"改称 Retrieval-Free Full-Artifact Exposure。
- 行为效用为主、制品审计为辅；功能性遗忘而非物理删除；跨域必须由共享潜变量支撑。
- Natural Output + Budget Sweep；Native-Model 与 Matched-Model 分轨；Fixed-History Replay 准入门；Writer Quiescence 协议。
- Task Design > Evaluation Design > Leaderboard；Common Memory 在冻结前不参与校准。

### 从"研究报告"到"可发布规范"的修正

| # | v0.3 报告 | Spec v0.1.0 | 理由 |
|---|---|---|---|
| 1 | 叙述性文稿 + 一份 YAML 摘要 | RFC 2119 规范用语 + 7 个 draft 2020-12 JSON Schema（`additionalProperties:false`） | 发布状态要求任何第三方都能机器校验其 world / task / 提交 |
| 2 | 版本号 v0.3 | Spec / Dataset / Harness 三个独立版本；Spec 从 0.1.0 起 | 文稿迭代号与规范版本混用会让"v0.3 报告 → v0.1 发布"看起来像倒退 |
| 3 | 隐含"可以做排行榜" | 明确为 Specification Release；无排行榜、无系统结论；校准候选一律"准入待验证" | 没有 Pilot 数据前的任何系统陈述都是不诚实的 |
| 4 | 单任务得分 \(s\in[0,1]\)，未定义违规如何进入分数 | \(s=\mathrm{clamp}(\sum_{pos}w_kc_k-\sum_{viol}w_jv_j,0,1)\)；正向权重和=1；8 类违规单独记录 | 让"没做对"与"做错了"可分离审计，并为 NTP / HS 提供原始数据 |
| 5 | NOR 未处理小分母 | 认证 C1 保证分母 ≥ 0.20；主报告用中位数，不裁剪负值 | 避免单任务分母接近 0 时指标爆炸 |
| 6 | 预算 4K / 16K 但未定义 token 计量 | `o200k_base` 对 canonical rendering 全文（含分隔符）计数；不合规不评分、不修复 | 不同 tokenizer 差异可达 20–30%，必须钉死 |
| 7 | `utility_budget_auc` 为主指标 | 移除；≥ 3 预算点时再启用 | 两个点的 AUC 只是均值 |
| 8 | 序列化规则为原则性列表 | `mwb-canonical-text/1`：排序键、记录头格式、metadata 与 content 段、转义规则、sha256 | 渲染是 Reader 实际看到的内容，任何自由度都会成为混杂变量 |
| 9 | Prompt framing 建议把记忆放在 system 块 | 三条消息：system=Invariants，user#1=`<external_memory>`，user#2=task；no_memory 时块仍存在且为 `(empty)` | 记忆放 user 轮更符合"证据非指令"；保留空块可控制"块存在与否"这一变量 |
| 10 | 8 个基线含 Full Transcript 与 Full History | 合并为 `full_transcript`；其余 7 个基线给出逐字构造（`templates/baseline-prompts.md`） | 无检索暴露下二者等价；rolling_summary / heuristic_salience 若无逐字定义则不可复现 |
| 11 | `oracle_ablated` = "从 Oracle 移除 required state" | 定义为 `oracle_maximal − required_state_ids` | 若从 oracle_minimal 移除则等于空记忆，C2 退化为 C1 |
| 12 | 认证为三条不等式 + "full-history 能完成" | standard C1–C5、null N1–N2、twin T1–T3，含具体阈值与 seed 要求 | null 任务与孪生对的"记忆依赖"含义不同，必须分开认证 |
| 13 | 因果检验只有公式 | Writer 必须分别摄入 base / counterfactual / noise 三份历史；noise 变体只能改动仅渲染噪声状态的事件；counterfactual 必须覆盖 pivot 的全部渲染事件（validator 强制） | 否则 CS / CI 可以被部分覆盖或顺带改动非噪声状态所污染 |
| 14 | 反 answer-cache 为原则 | 可检查规则：prompt 中 ≥ 8 词句子不得逐字出现于历史；任务应是历史工作项的邻居；违规正则不得自触发 prompt | 原则无法自动执行 |
| 15 | 跨域任务须声明共享潜变量 | 额外要求：共享状态 ⊆ required，且对 target 与至少一个 source 领域 `transferability=true`；required 不得含 obsolete / noise 状态 | 让"合法迁移"成为 schema 级约束而非审稿意见 |
| 16 | 任务类型隐含在四领域描述里 | 显式 `task_kind` 枚举（含 `isolation`）；`task_mix` 与实际计数一致 | 配比是 Distributional Evaluation 的前提 |
| 17 | 状态原子字段列表 | 增加 `attribution`（谁说的）与 `epistemic_status`（多可信）分离；`decision_field`；supersedes ↔ superseded_by 双向一致 | 归属错误与置信错误是两类不同的 harmful state |
| 18 | 历史格式未定义 | `history-event.v1`：5 种 role（含 file_change / system_note）、session/seq/day；`labels.yaml` 与事件分离 | Writer 只能拿到事件；labels 供审计 |
| 19 | World 规模只有 MVP 数量 | 每 world 最低要求：\(|Z|\ge15\)、六类齐备、≥10 session、≥20 天、噪声 ≥10%、obsolete 有明确替代者 | 保证每个 world 都能同时施加容量、时间、噪声三种压力 |
| 20 | "自动评分 ≥ 70%" | 重述为：hidden tests + deterministic + 二元 structured rubric ≥ 70%，开放式 LLM judge ≤ 30%（schema 与 validator 强制后者） | 文本类领域无法 70% 纯自动；二元盲测 rubric 是可控的结构化评分 |
| 21 | Judge 需与人工校准 | 每领域 ≥ 50 items，Cohen's κ ≥ 0.60 才可出正式结果；双 Judge 一致率记入 RunRecord | 把"可接受一致性"变成数字 |
| 22 | 统计协议列出方法 | 固定为 world 聚类配对 bootstrap 10 000 次 + Holm 校正 + bootstrap 名次分布；混合模型可选 | 任务在同一 world 内相关，按任务重采样会低估方差 |
| 23 | "指标向量 + 主指标" | Profile Card 模板，7 个必含部分，含 Failure profile；WFB 仅可选 | 明确"没有总分"是有意设计 |
| 24 | 准入要求 5 条 | 6 条（新增 `repeat_run_coverage_consistent`），全部为 WriterCard 布尔字段 | 报告原文第 3 条"重复运行覆盖一致"未在 YAML 中体现 |
| 25 | 数据切分"world-family 级" | 写入 `04`：private_test 每 6 个月轮换 ≥ 1/3；三个 split 的可见性与用途表 | 轮换节奏是防污染的一部分 |
| 26 | UR / HS 指向制品审计 | 由 RunRecord 行为数据定义（evidence_state_ids 加权得分 / 1 − 平均违规权重）；制品审计保持诊断层 | 与"Utility First, Audit Second"一致 |
| 27 | 无参考实现 | `examples/latticenote` 完整 world + `tools/validate.mjs`（schema、交叉引用、配比、反作弊、变体一致性、oracle 渲染） | 规范若不能在一个实例上跑通，就不是发布状态 |

### 参考 world 相对 v0.3 §3.9 示例的变化

- 六个任务改为可评分的 TaskSpec：coding 任务改为"备份导入的冲突处理"（历史工作项的邻居），并配 hidden tests；
- 新增 `variant.noise_logs` 用于 Causal Invariance；
- 反事实孪生绑定 `decision_field: explanation_order`，覆盖 pivot 的全部 6 个渲染事件；
- 注入内容改为出现在 `tool` 事件且伴随助手正确处置；助手幻觉 API 改为 `vi.retryFlaky()` 并有用户纠正事件。

### 已知未决（不在 v0.1 解决）

见 `spec/04` §4.8：阈值与预算点的经验支持、Reader 中性性、合成历史外部效度、审计抽取误差、on-policy 排名变化、多语言。
