# Common Memory V2：批准规格与实现决定

## 产品边界

持久化实际用户投递 → 稳定 Entry 绑定 → 混合触发 → 模型决策 → 有限 Markdown Section 更新 → 可恢复提交。
仅 Write 及必要当前状态检查。Markdown 是长期内容权威；runtime SQLite 是不可随意重建的队列、租约和来源元数据。删除 Fact/Proposal/Review、Recall/FTS/ranking/context pack、治理/Undo 及兼容层，不迁移、不删除工作区外用户数据。不引入 Temporary Store、向量库或常驻服务。

## 理由与批准计划的研究记录

有限 Section patch 而非整篇重写：CAS 只能防并发覆盖，无法识别模型遗漏。未修改 Section 逐字节保留。模型决定 admission、生命周期和语义；执行器仅校验协议、权限、秘密与资源边界，不设 confidence 阈值。

以下参考来源继承自批准的研究计划，属于设计启发，不是本实现的实测优胜证据：
- Hermes 周期检查：[turn_context](https://github.com/NousResearch/hermes-agent/blob/2e24e06e5513fa425ccf935d2e41991cb11ff383/agent/turn_context.py#L542-L551)、[后台隔离](https://github.com/NousResearch/hermes-agent/blob/2e24e06e5513fa425ccf935d2e41991cb11ff383/agent/turn_finalizer.py#L602-L616)。
- LangGraph/LangMem：[memory-template](https://github.com/langchain-ai/memory-template)。
- Letta：[sleep-time](https://www.letta.com/blog/sleep-time-compute/)、[memory blocks](https://www.letta.com/blog/memory-blocks/)。
- Mem0 更新、合并、删除：[论文](https://arxiv.org/abs/2504.19413)。
- 更新与不写应独立验收：[LongMemEval](https://arxiv.org/abs/2410.10813)。

每 Turn 成本高且片段化；仅结束会丢尾批；固定 N 无时间上界。Hybrid 是本项目设计选择，不宣称参数已优化。宿主事件顺序以锁文件安装的 Pi 源码核验。

## Capture / 调度

input 只登记来源与冻结 cwd→project。message_end 持久化待绑定，再用稳定 Entry ID 绑定；不依赖助手成功。未投递输入不得成为 evidence。模板变换、扩展来源、无法证明唯一关系和不支持的多模态输入保守隔离，不重标 global。宿主缺少完整投递链 ID 时宁可隔离，不猜来源。

默认 6 Turn / 16 KiB / 120 秒空闲 / 10 分钟最老积压；生命周期和本地 flush 请求处理。稳定边界执行；关闭只排队并取消网络。dataRoot 单任务、领取后不合并新观察、正常 FIFO；隔离/dead-letter 可见且不堵后续正常队列。60 秒 deadline、120 秒续租 lease、指数退避最多 5 次，可本地 retry。

## Model / Markdown

profile.md、preferences.md、projects/<宿主 id>.md。固定 H1、唯一 H2、自然 Markdown 正文；put_section/remove_section，合并/移动/改名组合原子操作。受限 ATX、识别 fenced code、拒绝未声明 H1/H2/Setext。软/硬预算初始 8/16 KiB。

完整用户 Turn + 最多前两轮 context_only + 当前授权完整文档 + 时间/版本/宿主句柄。助手上下文当前不披露；工具、系统、thinking、compaction 不进入请求。精确序列化上限 128 KiB，先减 context，再减完整 Turn；单条超限隔离、不截断、不消费。

memory_maintenance_v2：retain(remember/update/correct, stable/until_changed)、forget、maintain、ignore。引用必须宿主提供；context_only 不是新增 evidence。无效响应失败，不降级 no-op；ignore 原子消费。Project 批次不能写 global，包括空 evidence maintain。

维护指令随包发布，模型不能修改。新状态替换旧状态，纠正不是追加矛盾，临时通常 ignore，不从一次行为推出永久偏好，不把助手完成声明当事实，条件不泛化。Project realpath/最长祖先匹配；注册、披露、写授权分离；移除注册不删 Markdown。

## Recovery / Privacy

网络不持锁。repository lock → runtime DB 写事务 → token/generation/expiry fencing → 完整读取文档 CAS → Markdown + 永久回执事务 → DB 消费/来源关联 → DB commit。ignore 只做 DB 原子消费，但仍检查 snapshot CAS。

文件成功 DB 失败依永久回执恢复，不调用模型。COMMITTING 前不发布；标记后恢复原子替换；外部非预期改动 fail closed。测试含真实子进程强制退出。

永久回执仅来源引用、digest、before/after hash、决策枚举、模型/提示词版本、时间、usage；不留历史 Markdown、模型原响应、reason 或 Section 标题明文。关联键是 target+标题 hash，仅同一 decision 的合并/移动继承相关来源。processed body 默认 7 天清理；pending/隔离不伪装消费。forget 清理相关 processed body，保留不相关当前状态；不承诺删除 Pi transcript、安全擦除或永久禁止未来重新表达。

## 交付门槛

typecheck/lint/全量测试/build、remote contract（离线适配器协议）、真实 tarball typed consumer/Prompt/Pi/CLI 启动、双独立审查。30 轨迹三策略比较仅证明 scripted executor；真实模型语义质量独立 opt-in，未执行则明确标注缺口。
