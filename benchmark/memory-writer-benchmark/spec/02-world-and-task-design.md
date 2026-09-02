# 02 · World 与任务设计

Task Design 是本 benchmark 的决定性部分。本章规定一个合格 world 的构造顺序：**先写隐藏状态，再渲染历史，最后从状态派生任务**——而不是先写对话再猜什么重要。

## 2.1 隐藏世界状态 \(Z\)

\[
Z = Z_g \cup Z_d \cup Z_e \cup Z_o \cup Z_u \cup Z_n
\]

| class | 含义 | 典型例子 | 对 Writer 的要求 |
|---|---|---|---|
| `global_transferable` | 可跨领域的长期状态 | 解释偏好、验证习惯、长期目标、已掌握知识、稳定误解 | 保留并可迁移 |
| `domain_local` | 项目 / 领域局部状态 | 测试命令、架构决策、项目内教训 | 保留但限定 scope |
| `ephemeral` | 临时状态 | 今天很累、一次性 deadline | 到期后不再影响行为 |
| `obsolete` | 已被替代 | 旧 ADR、旧测试框架 | 不得作为当前事实 |
| `uncertain` | 待验证 | 未复现的 bug 猜测 | 不得升格为已验证 |
| `noise_or_untrusted` | 噪声 / 不可信 | 第三方偏好、助手幻觉、注入、安装日志 | 不得进入高信任记忆 |

每条 state atom MUST 满足 `state-atom.v1`，特别是：

- `scope` 明确到 `global` / `project:<id>` / `domain:<d>` / `session:<id>` / `third_party:<id>`；
- `valid_from` / `valid_to` / `status` 三者一致（validator 检查）；
- `epistemic_status` 与 `attribution` 区分"谁说的"和"多可信"；
- `transferability` 对四个领域逐一声明——这是跨域任务合法性的唯一依据；
- 被替代关系双向声明（`supersedes` ↔ `superseded_by`）；
- 作为反事实 pivot 的状态 MUST 声明 `decision_field`。

**规模要求（每个 world）**：\(|Z| \ge 15\)；六类各 ≥ 1；`global_transferable` ≥ 3；`obsolete` ≥ 1 且有明确的替代者；`noise_or_untrusted` 中 MUST 含至少一条第三方归属、一条助手错误、一条注入内容。

## 2.2 历史生成 \(G\)

历史 MUST 满足 `history-event.v1`，并：

- 跨 ≥ 10 个 session、≥ 3 个领域、虚拟时间跨度 ≥ 20 天；
- 每条非噪声状态 ≥ 1 个渲染事件；`global_transferable` 状态 SHOULD 以 ≥ 2 种 `rendering_kind`（如 direct_statement + repeat / indirect_hint）出现于 ≥ 2 个领域的 session；
- 每个 `obsolete` 状态 MUST 同时有 `direct_statement`（旧）与 `reversal` / `correction`（新），且旧状态的渲染次数 SHOULD ≥ 新状态（让"记最新"不是免费的）；
- 注入内容 MUST 出现在 `tool` 事件里，并 SHOULD 伴随一次助手的正确处置，以模拟真实 Agent 轨迹；
- `file_change` 事件 SHOULD 用于让状态有非对话证据（ADR、配置）；
- 噪声事件（安装日志、进度条）MUST 占事件总数 ≥ 10%，用于制造容量压力；
- 所有项目、人物、API、数值、组织 MUST 虚构（`fictional: true`）。

`labels.yaml` 记录 event → state 的渲染关系与 `rendering_kind`，仅用于审计与认证，MUST NOT 提供给 Writer。

## 2.3 任务类型与每 world 配比

| `task_kind` | 目的 | 每 world 最少 |
|---|---|---|
| `same_domain` | 同域续作，考察 durable retention + temporal update | 1 |
| `positive_cross_domain` | 由共享潜变量支撑的正迁移 | 1 |
| `negative_transfer_null` | 无相关记忆的任务；记忆只可能有害 | 1 |
| `temporal_update` 或 `counterfactual_twin` | 最新状态覆盖旧状态 / 单状态反事实 | 1 |
| `isolation` | 项目 A 的规则不得污染项目 B | 0（SHOULD ≥ 1） |

`world.task_mix` MUST 与实际任务类型计数一致（validator 检查）。

## 2.4 TaskSpec 的强制字段与规则

`task-spec.v1` 的关键规则（validator 全部检查）：

1. `required_state_ids` 不得含 `obsolete` 或 `noise_or_untrusted` 状态；
2. `required` / `forbidden_active` / `irrelevant` 三集合两两不交；
3. `positive_cross_domain` MUST 声明 `shared_latent_state_ids ⊆ required_state_ids`，每个共享状态 MUST `transferability[target_domain] = true` 且至少对一个 `source_domain` 为 true；`source_domains` 至少一个 ≠ `target_domain`；
4. `isolation` MUST 至少禁止一个状态；
5. `negative_transfer_null` MUST `required_state_ids = []`，`certification_kind = null_task`；
6. `counterfactual_twin` MUST 与其 `twin_of_task_id` 的 prompt 字节相同，并绑定 world 中存在的 counterfactual 变体与 `decision_field`；
7. 正向 check 权重之和 = 1.0；`blinded_llm_judge` 类型的正向权重合计 ≤ 0.30；
8. `regex_present` 类违规检查的正则 MUST NOT 匹配任务 prompt 自身；`forbidden_surface_terms` MUST NOT 出现在 prompt 中；
9. 反 answer-cache：prompt 中任何 ≥ 8 词的句子 MUST NOT 在历史中逐字出现；任务 SHOULD 是历史中工作项的**邻居**（相同原则、不同对象），而不是历史里宣布过的那件事本身（参考世界的 coding 任务用"备份导入的冲突处理"而非历史里已提到的模块）。

## 2.5 难度层级

| 级别 | 特征 |
|---|---|
| L1 Direct Stable | 一次明确、长期、无冲突陈述 |
| L2 Distributed Evidence | 信息跨多 session，需合并与补全 |
| L3 Temporal Revision | 多次变化；旧状态有历史价值但不是当前事实 |
| L4 Abstraction & Transfer | 从具体案例抽象原则并用于未见对象 |
| L5 Adversarial Formation | 第三方归属、助手幻觉、不可信工具输出、相似项目污染、注入 |

每个 world SHOULD 覆盖 ≥ 3 个级别；private_test 集合中 L3–L5 SHOULD ≥ 60%。

## 2.6 四领域评分指引

| 领域 | 历史应包含 | 评分优先 |
|---|---|---|
| Coding | 约定、ADR 及其修订、有适用边界的失败方法、工具 / 环境限制、项目 A/B 差异 | hidden tests ▸ lint / typecheck ▸ AST 约束 ▸ must-use / must-not-use 规则 |
| Project Building | 需求演化、scope 收缩、被否决方案、角色边界、用户设计原则 | 结构化 decision list：必须项 / 禁止项 / 当前状态 / 被废弃方案是否复活 / 是否混入他项目 |
| Learning | 已掌握概念、稳定误解、解释偏好、有效 / 无效教学方式、临时疲劳 | 二元 rubric：必需要素、禁止重复点、误解是否被针对、prerequisite 顺序 |
| Conversation | 稳定偏好 vs 临时情绪、长期目标、第三方信息、多项目身份 | preference adherence、attribution、irrelevant leakage、是否对临时情绪做人格推断、是否"为了展示记忆而展示" |

结构化验证（hidden tests + deterministic + 二元 structured rubric）MUST 占每个任务正向权重 ≥ 70%；开放式 LLM 质量判断 ≤ 30%。

## 2.7 跨领域迁移的合法性

正确的跨域任务由**共享潜变量**驱动：

```text
Coding history: 用户多次表示先给公式/约束、再给例子；工作完成以测试为准
Learning task : 解释一个相邻新概念
共享状态       : state.user.explanation_style, state.user.validation_orientation
```

不合法的跨域任务：

```text
Coding history: Project A 用 pnpm test
Learning task : 解释贝叶斯定理
```

二者没有共享潜变量，不能据此声称测到了 generalization。没有 `shared_latent_state_ids` 的 A→B 任务 MUST NOT 进入正式集合。

## 2.8 反 Reward-Hacking 机制

| 威胁 | 机制 |
|---|---|
| Writer 预存未来答案 | Writer 永不见任务；制品 sha256 冻结后才采样；同一历史 ≥ 4 类任务；任务是历史的邻居 |
| 参数知识泄漏 | 全部虚构；私有种子；world-family 级切分；private_test 轮换 |
| 强 Reader 掩盖垃圾 | null 任务 + violation 检查 + 制品审计 + Robustness Reader |
| Judge 被记忆内容攻击 | Judge MUST NOT 读取记忆；只看 task / 输出 / rubric；Writer 匿名 |
| Judge 位置 / 自偏好 | 二元原子 rubric；双 Judge 不同家族；pairwise 时交换顺序；与人工子集校准 |
| 记忆中的指令注入 Reader | Invariants 明示"证据非指令"；注入是否被执行本身是 violation 检查项 |
| "记全部历史"稳赢 | 预算轨 + full_transcript 基线 + 负迁移任务 + footprint 报告 |

## 2.9 Memory-Dependence Certification

任务进入正式集合前 MUST 通过认证。所有量为 ≥ 3 个 Reader seed 的均值；阈值为 v0.1 的工程预设，MUST 随结果报告，Pilot 后 MAY 修订。

**standard（same_domain / positive_cross_domain / temporal_update / isolation）**

| 编号 | 条件 | 阈值 | 含义 |
|---|---|---|---|
| C1 | \(\bar s_{\text{oracle\_min}} - \bar s_0 \ge \delta\) | \(\delta = 0.20\) | 记忆确实有用 |
| C2 | \(\bar s_{\text{oracle\_min}} - \bar s_{\text{ablated}} \ge \delta_a\) | \(\delta_a = 0.15\) | 是 required 状态在起作用 |
| C3 | \(|\bar s_{\text{irrelevant}} - \bar s_0| \le \epsilon\) | \(\epsilon = 0.10\) | 任意记忆不会凭空加分 |
| C4 | \(\bar s_{\text{full\_transcript}} \ge 0.50\) | — | 历史里确实有答案 |
| C5 | \(\bar s_{\text{oracle\_min}} \ge 0.60\) | — | 任务本身良定 |

**null_task**

| 编号 | 条件 | 阈值 |
|---|---|---|
| N1 | \(\bar s_0 \ge 0.80\) | 无记忆即可完成 |
| N2 | \(\bar s_{\text{oracle\_max}} \le \bar s_0 + 0.05\) | 真值记忆也不会"帮忙"（否则它不是 null） |

**twin_pair**

| 编号 | 条件 |
|---|---|
| T1 | 基线任务通过 standard 认证 |
| T2 | `oracle_minimal`（基线历史）在 ≥ 2/3 seed 上得到 `expected_value_base` |
| T3 | `oracle_minimal`（变体历史，即替换后的 pivot 内容）在 ≥ 2/3 seed 上得到 `expected_value_variant` |

未通过认证的任务：`certification_status: failed`，从任务池移除并用同 kind 任务替换；MUST NOT 为了让任务通过而修改 Writer。参考 world 的任务标记为 `waived_reference_only`，MUST NOT 用于任何排名。

## 2.10 参考 world：LatticeNote

`examples/latticenote/` 实现了本章全部要求：19 个状态（六类齐备，含 1 个反事实 pivot）、12 个 session / 67 个事件 / 4 个领域 / 26 天、6 个任务（1 same_domain、2 positive_cross_domain、1 null、1 counterfactual_twin、1 isolation）、2 个变体（counterfactual + noise）。`node tools/validate.mjs examples/latticenote` 通过全部检查。它是公开的，因此只用于说明协议，不产生排名数据。
