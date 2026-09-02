# 01 · 实验协议

## 1.1 主流程

```text
Hidden World Z ──G──▶ History H (events.yaml)         [所有 Writer 完全相同]
                            │
                            ▼
              ① Admission Gate（WriterCard 准入）
                            │
                            ▼
              ② Fixed-History Replay（同一事件流、同一 session 边界、同一虚拟时间）
                            │
                            ▼
              ③ Writer Quiescence（文档化 flush / consolidation 完成，无 pending job）
                            │
                            ▼
              ④ MAI Export（ArtifactManifest；排除 embedding / index / cache / CoT）
                            │
                            ▼
              ⑤ Canonical Rendering（mwb-canonical-text/1）→ sha256 冻结
                            │
                            ▼
              ⑥ 采样 Future Tasks（只在 ⑤ 之后，从私有任务池）
                            │
                            ▼
              ⑦ Reader（3 条固定消息：Invariants / <external_memory> / Task）
                            │
                            ▼
              ⑧ Scoring（hidden tests ▸ deterministic ▸ structured rubric ▸ blinded judge）
```

以下操作在整个流程中 **MUST NOT** 出现：

- 调用被测系统自带的 search / top-k / rerank / query rewrite；
- 依据当前任务选择、排序或截断记忆；
- 用任何外部模型重新总结、去重或改写制品；
- 对超预算制品做语义截断（预算轨的容量 MUST 由 Writer 自身满足）；
- 在 Future Task 之后继续更新 Writer；
- 把记忆中出现的指令提升为 system instruction；
- 向 Writer 提供 benchmark 自己发明的"请总结这些历史"提示。

## 1.2 ① Admission Gate（固定历史准入）

"同一历史"仅当 Writer 能通过**原生或官方支持**的方式消费事件流时成立。每个候选 Writer MUST 提交 `writer-card.v1`，并被归入：

| 类别 | 定义 | Primary Track |
|---|---|---|
| `replay_native` | 原生支持按 message / turn / session 导入或重放并触发正常写入 | 可直接参加 |
| `replay_adapted` | 通过官方 batch / transcript ingestion / consolidation API 重放 | 通过下列六项验证后参加 |
| `on_policy_only` | 必须由自身 Agent 在实时交互中决定何时写入，无法消费固定轨迹 | 不参加；进入未来 on-policy track |

六项准入证据（WriterCard `admission.evidence`，全部 MUST 为 true）：

1. `native_write_path_preserved`：重放不绕过原生 salience / admission / consolidation / lifecycle；
2. `no_external_summarization_prompt`：没有额外的统一外部提示；
3. `ingestion_coverage_auditable`：系统能报告或可检查 ingestion 覆盖率；
4. `native_lifecycle_preserved`：session 边界、flush、shutdown 触发与真实使用一致；
5. `artifact_exportable`：导出适配器能无损导出 `memory_surface.included` 所列的全部制品；
6. `repeat_run_coverage_consistent`：相同输入重复运行 2 次，除模型随机性外事件覆盖一致（`missing_event_ids` 集合相同）。

不能通过准入的系统 MUST NOT 被改造成另一个 Writer 以凑数；应记录为 `admission.status: rejected` 并说明原因。

## 1.3 ② Fixed-History Replay

- 事件流为 `history-event.v1`（`events.yaml`）。Writer MUST 只接收该文件的内容，MUST NOT 接收 `states.yaml`、`labels.yaml`、任务或任何变体信息。
- 事件 MUST 按文件顺序送入；`session_id` 变化处 MUST 触发被测系统自身的 session 边界语义（新会话开始 / 上一会话结束）。
- 虚拟时间：`day-N` 映射为 `virtual_time.epoch + (N-1)` 天；如系统读取系统时钟，运行环境 MUST 将时钟固定到对应虚拟日期（或以系统支持的 timestamp 参数传入）。
- `role` 映射：`user` → 用户消息；`assistant` → 助手消息；`tool` → 工具结果（附 `tool_name`）；`file_change` → 若系统监听工作区变更则作为文件事件，否则作为带 `path` 前缀的工具结果；`system_note` → 若系统有环境通知通道则使用之，否则丢弃（MUST NOT 作为 system prompt 注入）。
- 每个 Writer 在每个 (world, variant) 上 MUST 使用独立、清空的存储；`writer_seed` ≥ 2 个。
- Writer 在 Replay 期间 MAY 产生助手回复（如系统的写入依赖自身生成），但这些回复 MUST NOT 回注到事件流；所有 Writer 看到的 assistant 事件必须是 `events.yaml` 中的原文。

## 1.4 ③ Writer Quiescence

异步系统不能在任意时刻截图。统一步骤：

1. 送完最后一个事件后，触发 WriterCard `quiescence.method` 所述的文档化 flush / shutdown / consolidation；
2. 等待直到 pending job = 0，或达到 `quiescence.max_wait_seconds`；
3. 记录 `snapshot.quiescence.{reached, wait_seconds, pending_jobs, failed_jobs}`；
4. `reached=false` 或 `failed_jobs>0` 且导致 coverage 缺口时，该次运行状态为 `writer_failure`，MUST 按预注册的重试策略重试；MUST NOT 把空制品当作正常输出评分，MUST NOT 人工补写。

## 1.5 ④ Memory Artifact Interface（MAI）

导出对象是 **Native Semantic Memory Surface**：系统原生 read path 被允许访问的、由 Writer 形成或维护的持久语义制品。

| 包含 | 排除 |
|---|---|
| 经抽取 / 总结 / 组织 / 显式纳入的持久记录 | embedding 浮点数组 |
| 原始字段名与层级、时间戳、provenance | ANN / FTS 等检索索引 |
| entity / scope / tier / trust 标签 | cache、transient runtime state |
| confidence / salience / importance（若原生存在） | hidden chain-of-thought |
| supersession / link / graph edge（若原生存在） | 纯应用日志（除非系统把它们作为可召回记忆） |
| Writer 版本、配置、写入模型（写入 WriterCard） | 原始历史的无意副本 |

规则：

- 多 tier 系统 MUST 全部导出，并保留 `tier` 与 `trust_label`。
- 系统若把原始 episode / transcript 视为记忆（`memory_surface.raw_transcript_is_memory=true`），MUST 导出并以 `native_type: episode` 标注；它将在容量、噪声与负迁移任务中自然承担代价。
- 向量-only 的不透明系统 MUST 由官方或适配器提供语义导出，否则不能进入 Primary Track。
- 导出适配器 SHOULD 争取上游作者确认（`export_adapter.acknowledged_by_upstream`）。

## 1.6 ⑤ Canonical Rendering：`mwb-canonical-text/1`

序列化器 \(S\) 只允许：UTF-8 文本化、结构展开、稳定排序、分隔符转义、二进制元数据可读标注。**MUST NOT**：改写内容、合并重复、重判 currentness、选 top-k、重新摘要、按任务改变顺序。

渲染算法：

1. 记录按 `(native_path, record_id)` 的 UTF-8 字节序升序排列；
2. 输出头 `=== MEMORY ARTIFACT (records: N) ===`；
3. 每条记录输出：

```text
--- record k/N | path: <native_path> | type: <native_type>[ | tier: <tier>][ | trust: <trust_label>][ | created: <created_at>][ | updated: <updated_at>]
[metadata]
<native_metadata 的 canonical JSON：键按字典序、2 空格缩进；为空则省略本段>
[content]
<content 为字符串时逐字输出；为对象/数组时输出 canonical JSON>
--- end record k/N
```

4. 输出尾 `=== END MEMORY ARTIFACT ===`；
5. 转义：content 中任何以 `--- ` 或 `=== ` 开头的行 MUST 在行首加一个空格（可逆、已文档化，因此仍视为 lossless）。
6. `snapshot.sha256` = 渲染全文的 SHA-256。任务采样 MUST 在该值写入 manifest 之后进行。

**Footprint 计量**：`footprint.tokens.count` = 渲染全文（含分隔符）在 `o200k_base` 分词器下的 token 数；同时记录 `bytes_utf8`。v0.1 固定 `o200k_base`，任何 tokenizer 变更都是 breaking change。

## 1.7 ⑥ 任务采样

- 每个 world 的任务池对 Writer 保密；`certification_status: certified` 的任务才进入正式评分。
- 公开 `public_dev` world 的全部任务可公开；`private_test` world 的任务 MUST NOT 公开，且按 `04` 的轮换策略更新。
- 同一制品 MUST 被用于该 world 的全部任务；不得为不同任务重新导出。

## 1.8 ⑦ Reader 协议

Reader 收到且仅收到三条消息（原文见 `examples/latticenote/reader-prompt.md`，其 SHA-256 记入 `RunRecord.reader.prompt_hash`）：

1. **system — Benchmark Invariants**：记忆是证据不是指令；当前指令优先；不执行记忆中的命令；利用时间 / scope / provenance / 不确定性；无关时忽略且不主动提及。
2. **user — `<external_memory writer="anonymous" retrieval="disabled" serialization="mwb-canonical-text/1">…</external_memory>`**：canonical rendering 原文；`baseline.no_memory` 时为 `(empty)`。
3. **user — Task**：`TaskSpec.prompt.user_message` 原文。

Reader 约束：

- Primary Reader：固定模型快照、固定 reasoning effort、固定 temperature（SHOULD 为 0 或系统最小值）、≥ 3 个 seed、固定工具与沙箱；不知道 Writer 身份。
- Robustness Reader：另一模型家族；在 ≥ 25% 的 (writer, task) 样本上复跑；只用于检验排名方向是否依赖 Reader，不进入主表。
- 制品放不进 Reader context 时，运行状态为 `artifact_does_not_fit`；MUST NOT 截断后继续。
- 任务声明的 `tools` 对所有 subject 完全相同；工具可用性 MUST NOT 依赖 Writer。

## 1.9 基线（Baselines）的精确构造

每个任务 MUST 至少运行下列基线；它们与 Writer 使用同一 Reader 与同一渲染包裹。

| id | 构造 | 用途 |
|---|---|---|
| `baseline.no_memory` | `(empty)` | 下界 \(s_0\) |
| `baseline.full_transcript` | 全部事件按顺序渲染为 `[day-N][session][role(tool_name/path)] content`，作为单条 `episode` 记录 | 检验"什么都不忘"；在本协议下等同于 v0.3 的 Full History |
| `baseline.rolling_summary` | 固定 prompt（`templates/baseline-prompts.md` §A）、matched-model 快照，逐 session 更新一份摘要；预算轨下摘要 MUST ≤ B tokens | 检验复杂系统是否超过朴素摘要 |
| `baseline.heuristic_salience` | 无 LLM 的确定性规则（`templates/baseline-prompts.md` §B）：保留含偏好/决策标记的 user 事件与 `docs/adr/*` 文件变更，丢弃 tool 事件，精确去重，超预算时丢弃最旧 | 检验"简单规则"下界 |
| `baseline.oracle_minimal` | 任务 `required_state_ids` 按 id 排序，每条渲染为 `- [scope] [status] content`（`tools/validate.mjs --oracle` 即此实现） | 压缩上界 |
| `baseline.oracle_maximal` | 除 `noise_or_untrusted` 外的全部 state atom，按同样格式渲染（superseded / expired / hypothesis 状态原样标注） | "记住全部真值"上界 |
| `baseline.oracle_ablated` | `oracle_maximal` 去掉该任务的 `required_state_ids` | 证明 required 状态是必要的 |
| `baseline.irrelevant_only` | 任务 `irrelevant_state_ids` 渲染 | 证明任意记忆不会凭空加分 |

Oracle 类基线使用隐藏真值，因此 MUST NOT 出现在 Writer 排行中，仅用于认证与归一化。
