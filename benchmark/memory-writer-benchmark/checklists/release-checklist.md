# 发布清单 — MWB Spec v0.1.0

每项在发布前必须有可指向的证据（文件路径、命令输出或链接）。

## A. 规范一致性

- [x] `spec/00`–`04` 使用 MUST / SHOULD / MAY；与 schema 冲突处以 schema 为准
- [x] 7 个 schema 均为 draft 2020-12，`additionalProperties: false`
- [x] 单任务得分公式、8 类违规、认证阈值（δ=0.20, δ_a=0.15, ε=0.10）、预算点（4096 / 16384）、tokenizer（`o200k_base`）、渲染器（`mwb-canonical-text/1`）在正文中各只定义一次
- [x] 基线共 8 个，`run-record.v1` 的 subject.id 正则与 `spec/01` §1.9 一致
- [x] `utility_budget_auc` 已从 v0.1 主指标移除（仅 2 个预算点）

## B. 参考 world

- [x] `node tools/validate.mjs examples/latticenote` 退出码 0
- [x] 六类状态齐备；≥ 1 反事实 pivot 带 `decision_field`
- [x] 任务配比与 `task_mix` 一致；twin prompt 与 base 字节相同
- [x] 反 answer-cache 检查通过（无 ≥ 8 词句子与历史重合）
- [x] hidden test bundle 中的测试名与 TaskSpec 引用一致
- [x] `reader-prompt.md` 冻结文本存在

## C. 可复现性

- [x] WriterCard 示例通过 schema（`node tools/validate.mjs examples/latticenote --writer-card templates/writer-card.example.yaml`）
- [x] 基线 `rolling_summary` / `heuristic_salience` 有逐字定义（`templates/baseline-prompts.md`）
- [x] Profile Card 模板包含 §3.10 要求的 7 个部分
- [ ] Harness 实现 RunRecord 输出（v0.1 不包含 harness；由实现方完成）

## D. 治理与诚实性

- [x] README 明确 v0.1 = Specification Release，无排行榜、无系统结论
- [x] 校准候选全部标注"准入待验证"
- [x] Common Memory 不参与校准的政策写入 `spec/04` §4.7
- [x] 已知限制 8 条随规范发布
- [x] CHANGELOG 记录从研究报告 v0.3 到 Spec v0.1.0 的每项修正及理由

## E. 发布后 30 天内

- [ ] Sanity Pilot 8 个 `public_dev` worlds 起草并通过 validator
- [ ] 至少 1 个外部 Writer 完成 admission 流程并公开 WriterCard
- [ ] 人工校准子集（每领域 ≥ 50 items）标注启动
