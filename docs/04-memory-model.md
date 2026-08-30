# 权威记忆与治理模型

Canonical 记录仍为 Fact、Proposal、Review。自动 Proposal 使用 `source.client: memory_manager`，对应 approved Review 使用 `reviewer.type: memory_manager_policy` 和非空 `execution`。人工 Review 的 `execution` 必须为 null；补偿使用 provider-neutral `local_user` 身份和 `mode: compensation`。

`execution` 固定包含 batch/operation ID、1-based sequence/batch_size、intent、policy version、source/payload digest、批次 base knowledge/store revision 和 compensation 反向边。全部 Proposal 先形成首条 Review pre-image；Review 按 operation ID UTF-8 排序串联 revision，最后由单次 transaction 发布。

MemoryAnalysis action：add、modify、replace、merge、distill、expire、archive、no_op。Core 仍只执行 add_fact、supersede_fact、expire_fact；merge/distill/modify/replace/archive 降低为 supersede，archive 只改变 priority。

Undo 的 preview 固定 compensation batch identity 与 plan digest。Apply 先按既有 batch/反向边幂等恢复，再执行 stale/dependency 检查。历史记录不修改、不删除；恢复的是新 provenance 下的语义克隆。
