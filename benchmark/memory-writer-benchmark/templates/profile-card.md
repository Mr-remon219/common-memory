# Profile Card — {writer.display_name}

> 结果解释范围：Reader **{reader_id / model_snapshot}**，暴露协议 `mwb-canonical-text/1`，后端条件 **{native_model | matched_model}**，数据集 **{dataset_version}**，Spec **{benchmark_version}**。本卡不是跨场景的绝对排名。

## 1. 身份

| 字段 | 值 |
|---|---|
| writer_id | |
| 组件面 | |
| 仓库 @ commit | |
| 写入模型 / reasoning effort | |
| 准入类别 / 状态 | |
| 导出适配器（上游是否认可） | |
| config_hash | |

## 2. 一级指标（已认证任务，n = {N}）

| 指标 | 值 | 95% CI（world 聚类 bootstrap） |
|---|---|---|
| Memory Gain (MG) | | |
| NOR 中位数 / 均值 | | |
| U(4096) — 合规？ | | |
| U(16384) — 合规？ | | |
| Negative Transfer Penalty (NTP) | | |
| null 任务平均违规权重 | | |

### Transfer Matrix \(G_{a\to b}\)（行 = source，列 = target；n<3 标灰）

| | coding | project_building | learning | conversation |
|---|---|---|---|---|
| coding | | | | |
| project_building | | | | |
| learning | | | | |
| conversation | | | | |

## 3. 因果检验

| 指标 | 值 | pairs |
|---|---|---|
| Causal Sensitivity (CS) | | |
| Causal Invariance (CI) | | |

## 4. 写入–遗忘平衡

| 指标 | 值 |
|---|---|
| Useful Retention (UR) | |
| Harmful-State Suppression (HS) | |
| Obsolete-as-Current Rate | |
| Irrelevant Retention | |
| Poison Promotion Rate | |
| 违规类别分布（obsolete / false / third_party / local_as_global / uncertain / injection / leakage / ephemeral） | |

## 5. 成本与容量

| 指标 | natural | 4096 | 16384 |
|---|---|---|---|
| footprint tokens (o200k_base) | | | |
| records / files / edges | | | |
| write model_calls / input+output tokens / wall s / failures | | | |

## 6. 稳健性

- Robustness Reader（{family}）上 MG 与 NTP 的方向是否与 Primary 一致：
- 排名稳定性（bootstrap 名次分布）：

## 7. Failure profile

（一段文字。指出该 Writer 在哪些任务类型、领域组合、违规类别上系统性失分；给出 1–2 个最具代表性的 RunRecord id 作为证据。）
