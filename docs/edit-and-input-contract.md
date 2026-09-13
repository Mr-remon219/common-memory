# 显式编辑、输入字节限制与按需读取（v0.4.1 源码）

本页是当前有界实现契约，不承诺真实模型的语义正确率。版本号与发布记录以主 README / CHANGELOG 为准。

## 原生编辑与结果

- TUI `modifyMemory()` 和 Pi `/memory` 的用户编辑器共用 `validateMemoryEdit` / `queueMemoryEdit`。
  授权、完整输入、安全扫描与幂等身份在提交层检查；TUI 的等待、信号监听和 60 秒前台期限仍独立。
  Pi 异步接受后唤醒原消费者。取消等待不撤销持久请求。
- 只有可信原生入口提交 `taskKind: edit`；来源仍为 `interactive` / `user_explicit`。
  普通会话、MCP relay、两类 import 和旧观察默认 `observation`，不根据文字或 interactive 来源猜编辑意图。
  每个 edit 请求单独领取，不与普通学习或另一 edit 混批；沿用原 observation / Bundle / job / lease。
- Core 的 `memory_task_v1.task_kind` 是可选兼容字段；缺省为 observation。普通
  `memory_maintenance_v2` schema 不变；仅 edit task 提供要求 `edit_result` 的 schema：

| `edit_result` / 状态中的 `editResult` | Core 检查与用户含义 |
| --- | --- |
| `modified` | 必须有通过原证据、范围、目标读取及 patch 检查的操作，且实际 Markdown 字节改变 |
| `already_satisfied` | 必须完整读完所有授权快照文档；无操作。例如删除目标已经不存在，不强制写入 |
| `clarification_required` | 当前材料已完整读取，但不能安全确定修改；无操作，由用户进一步说明 |
| `refused` | 当前材料已完整读取，但本次不执行；无操作，由用户审阅请求与权限 |

后三类使用无操作的 ignore decision，**但单独普通 ignore 永远不能完成 edit**。
所有结果仍须完整读取当前来源；already_satisfied 同样受完整快照 CAS 保护。
编辑只允许写用户所选范围，不能因同时获准读取 global 而把 project 编辑扩展到 global。
Core 验证的是结构、授权、读取覆盖及实际字节变化，不是对模型“已经满足”判断的语义证明。

结果只保存有界枚举，和原 job 完成、DB receipt 一起原子落地；有文件操作时也写入原 canonical receipt，
files-before-DB 恢复重新投影该结果，不再调用模型。模型自由 reason 不保存为状态或通用诊断。
`processed` 是处理终态，不保证编辑完成；TUI `complete` 仅对 modified / already_satisfied 为 true。
两类 import 的归属、证据与禁止独立 forget 用户来源内容的规则不变。

SQLite 升级事务只补 `observations.taskKind DEFAULT 'observation'` 与 `jobs.editResult`，
不改变旧 ID、文本、Bundle、lease、来源链接或 receipt。旧请求重放不自动升级为 edit；
同身份更换 taskKind 是冲突，不复活已处理、dead 或 quarantined 输入。升级前停止旧写进程并备份完整 dataRoot。

## 输入限制（UTF-8 字节，不是 token）

| 配置 | 确切计量与阶段 |
| --- | --- |
| `disclosure.maxExcerptBytes` | **完整来源序列化上限**，所有入口及 Core 执行，不依赖 projection 的键名或分页块大小 |
| `disclosure.maxCandidateBytes` | **deprecated**；仍以更严格值约束完整来源，不静默忽略。迁移到 maxExcerptBytes 时取两者较小值，再由用户明确清除旧字段 |
| `disclosure.maxTotalBytes` | 完整来源批次总量，以及 Runtime 每个实际序列化 provider 请求总量；后者包括 system、tools/schema、材料、笔记和当前模型上下文 |

完整来源统一用 `JSON.stringify({excerpts:[{text:完整持久来源字符串}]})` 的 UTF-8 字节数计量。
保留旧原生编辑 envelope 的开销，避免旧显式上限被静默放宽。普通文本在 TUI、Pi、MCP relay
具有完全相同的边界；agent/document import 的 text 是原完整结构 envelope（含 attribution、gaps 等），
不是只提取 understanding 或正文来计量。Core 对独立 conversation context 按完整消息计量，不按分页块计量。
新规则对此前遗漏检查的路径以及序列化开销更保守，临界大小旧输入可能被拒绝；不会隐式提高配置值。

`inputLimits()` / TUI Current Configuration / Pi info / MCP status 显示有效 `maxSourceBytes`、
原 `maxInputBytes`（总量）和 `deprecatedLimits` 提示。Max Input 为 Unlimited 但完整来源限制有限时，
完整来源限制依然生效。原 maxBytes / maxTotalBytes 公共导入参数保留；新增 limits 可传完整 disclosure。

原生显式提交、relay/init/document ingress 在入队前拒绝超大输入，不截断。
已持久化的自动会话或旧队列由 Core 在任何 Runtime 调用前复查，超大完整来源/turn 隔离并保留原文。
先移除可选前轮上下文，再按原逻辑将末尾完整 turn 放回 pending；不拆当前 user/steer/assistant/tool 组。
后续 turn 的超大上下文只隔离其所属 turn，不隔离健康队首。总 wire 超限在 fetch 前明确失败，原队列保留。
仅分页不保证任意大来源能在模型窗口/期限中完成。

Unlimited 不取消独立资源限制：MCP 1 MiB framing、8 KiB 分页、会话暂存预算、canonical 文档预算、
模型窗口、输出 token 上限、整个尝试期限、Agent 轮数与重试/退避均仍独立。

## 读取当前 Markdown

Hook / Pi 首次快照及既有显式 refresh 不变。`memory_read` 每次按当前授权直接读取 Markdown，
不打开 SQLite、不唤醒 Writer，也不更新 Hook 缓存。
工具描述、Pi 模型可见正文和读取返回的可选 `guidance` 指明：本次返回的 contexts/targets
替代同范围旧快照和先前读取，包括空文档和删除；未返回的范围不变。重新挂载旧快照也不应恢复被替代内容。
这只是明确的消费指导，不是后台推送、轮询、版本历史或语义优先级裁决系统。

MCP 工具名称、relay/init/read 固定 profile 与默认权限不变；没有新增 memory_update，
也没有让模型参数冒充用户编辑授权。只读旧字段和普通 observation 结果保持兼容，新增结果/指导字段为可选。

## 验证入口

新增：`tests/v2/{edit-ingress,input-limits,read-guidance}.test.ts`。
相关定向回归：`tests/cli/modify-memory.test.ts`、`tests/v2/{pi-memory,pi-integration,writer,writer-recovery,session,runtime,document-import}.test.ts`、
`tests/mcp/{ingress,protocol,discovery}.test.ts`、`tests/memory-agent-runtime/{agent,provider}.test.ts`。
全部使用临时存储及合成 Runtime/provider；不涉及真实维护模型或个人配置。
独立 reviewer、全量 verify、安装包 consumer 和真实 WSL/宿主验收属于后续发布 gate。
