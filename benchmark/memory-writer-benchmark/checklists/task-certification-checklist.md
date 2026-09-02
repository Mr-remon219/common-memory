# 任务认证清单（每个任务一份，随 `certification_record` 归档）

任务：`task.___`　world：`world.___`　kind：`___`　认证人：___　日期：___

## 0. 静态检查

- [ ] `tools/validate.mjs` 对所在 world 退出码 0
- [ ] prompt 不含答案关键词（如"supersession"、"append-only"、"formula first"）
- [ ] prompt 是历史工作项的邻居，而非历史中宣布过的那件事
- [ ] 每个正向 check 至少对应一个 `evidence_state_ids`，或明确是任务本身的完成度
- [ ] 每个 `forbidden_active_state_ids` 至少被一个 violation check 覆盖
- [ ] `forbidden_surface_terms` 中没有该任务合理回答会自然用到的词

## 1. 运行基线（≥ 3 reader seeds，Primary Reader）

| 基线 | \(\bar s\) | seed 值 |
|---|---|---|
| no_memory | | |
| oracle_minimal | | |
| oracle_ablated | | |
| irrelevant_only | | |
| full_transcript | | |
| oracle_maximal（null / twin 需要） | | |

## 2. 判定

**standard**

- [ ] C1 oracle_min − no_memory ≥ 0.20
- [ ] C2 oracle_min − ablated ≥ 0.15
- [ ] C3 |irrelevant − no_memory| ≤ 0.10
- [ ] C4 full_transcript ≥ 0.50
- [ ] C5 oracle_min ≥ 0.60

**null_task**

- [ ] N1 no_memory ≥ 0.80
- [ ] N2 oracle_max ≤ no_memory + 0.05

**twin_pair**

- [ ] T1 base 任务已通过 standard
- [ ] T2 base 历史 + oracle_min → decision_field = expected_base（≥ 2/3 seeds）
- [ ] T3 变体历史 + oracle_min（替换后 pivot）→ decision_field = expected_variant（≥ 2/3 seeds）

## 3. Judge 检查（含 structured_rubric / blinded_llm_judge 的任务）

- [ ] 双 Judge 与 Reader 不同家族
- [ ] rubric item 均为二元、可独立判定
- [ ] 在基线输出上双 Judge 一致率 ≥ 0.80；否则改写 rubric

## 4. 结论

- [ ] `certified` — 写入 `memory_dependence.certification_status`
- [ ] `failed` — 原因：___ ；替换任务 id：___

禁止：为了让任务通过而修改任何 Writer；为了让任务通过而在 prompt 中加入答案提示。
