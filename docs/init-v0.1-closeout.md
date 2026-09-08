# Init v0.1 收尾验收 — 2026-09-07

后续证据：2026-09-08 用户确认的 Work 本地会话已实际完成 Init 与读回，见 [验证增补](init-v0.1-verification.md#work-local-evidence-2026-09-08)。下文保留各次运行当时的范围与结果。

本轮基线 `e09262c`，Node `24.20.0`，Linux。`v0.1` 是 Init 里程碑；包仍为 `0.2.0`、`private:true`，未发布、未切换正式配置。修改范围来自审批版方案，不涉及检索、索引、HTTP MCP、额外模型预处理、Memory 自动清理或 provenance 扩权。

后续 smoke 复用改造、重构后的 DeepSeek 复验及当前各 Provider 等级见 [Provider 验证复用](provider-verification.md)。本文保留各阶段原始验收条件与历史结果。

## 2026-09-08 统一网络层后的最新结果

**指定模型的完整 Init + Markdown 真实链路已在三套独立临时存储中通过。**
以下新结果替代下文“Markdown 未通过”的历史验收状态；原失败证据保留，不重置旧 dead/retry job。

前期使用相同完整维护请求对照：默认 Node 路线收到 HTTP 200 后正文连接重置；显式代理路线约 1.9 秒得到完整输出。由此确认当时 Markdown 失败包含**该环境的请求路线问题**，没有证据说明 Markdown 解析器损坏或 DeepSeek 不支持 Responses。补齐 schema 字段类型解决的 HTTP 400 是另一个已单独确认的问题。关闭思考、调整角色的作用不能冒充所有历史失败的单一根因；预算仍为 4096，Writer 期限仍为 60 秒。

本次采用 `deepseek-v4-flash-vision-exp` / `https://api.deepseek.com/responses` / strict schema / 显式 `reasoning.effort=none`，通过 Common Memory 自己的 env 网络客户端。每轮创建全新 home/dataRoot；Key 仅从环境读取，不写配置或报告。**隔离子进程明确设置 `no_proxy=""`、`NO_PROXY=""`**：原宿主列表含 CIDR，而本轮产品明确拒绝 CIDR。因此这里证明的是这条明确配置的代理路线，不能宣称“原宿主环境原样可用”。正式配置、symlink 和 Memory 均未改。

| 独立轮次 | Init Runtime 尝试 | Markdown Runtime 尝试 | 最终证据 |
| --- | --- | --- | --- |
| A：`/tmp/cm-deepseek-smoke-3MCAyv/report.json` | 2；首轮 Core 拒绝不合法 decision | 2；首轮 HTTP 200 / model_output / invalid_json | CLI 退出 0；2 份 DB 回执、2 份文件回执；重启无 Key read 同时读到 Quillon、Fedora、fish |
| B：`/tmp/cm-deepseek-smoke-Zqd7hN/report.json` | 1 | 1 | 同上 |
| C：`/tmp/cm-deepseek-smoke-FSvXWo/report.json` | 1 | 1 | 同上 |

每次重试沿用原 Runtime 退避和上限，没有放宽 Core、修复模型 JSON、换模型或制造回执。成功 observation 不显示旧错误，job 仍保留受控历史诊断。此前初步网络 smoke `/tmp/cm-deepseek-smoke-oz5Ux7/report.json` 的 Markdown 首次非法 JSON 也保留为失败记录，不从报告中剔除。

真实模型仍偶发非法 JSON 或 Core 不接受的 decision，不能承诺每次首次成功。原 tide-table 样本与 Init 的 Rust 周末偏好部分重复，实际模型合法 `ignore` 不能作为“未提交却冒称 retained”。最终留存样本改为明确且非重复的 Fedora Silverblue / fish 偏好；原始文档仍是 `document_import`，没有提升为用户声明，也没有合成模型替代 Writer。

统一网络层、迁移规则、NO_PROXY 精确语义、局部秘密、连接 ownership 和错误分层见 [研究与审查设计](outbound-network-design.md)；逐轮安全诊断、job/receipt ID 和读取摘要见 [机器可读验收记录](outbound-network-verification.json)。

最终完整 `node scripts/verify.mjs`：**26 文件 / 341 测试、类型检查、46 源文件边界检查、干净构建通过**，日志 `/tmp/cm-network-verify-final.log`。构建后 Linux `npm run test:consumer` 验证真实 pack 的类型、资源、Writer、Pi 加载与 CLI，日志 `/tmp/cm-network-consumer-final.log`。独立设计审查与实施复审已完成；确认并修复 legacy fetch 捕获时机、隧道后断连归因、Pi flush 异常清理。新保留秘密名过滤同时覆盖大小写，但 Windows 仍未实跑。

三轮正式 Memory 前后摘要均为 `c4e1a57b4617869cc30b69d1c4e93c76bb0112985bedde2b4f9662ba17ac75a7`。

剩余限制：原宿主 CIDR bypass 列表需要用户明确改成支持的列表或使用 custom；SOCKS5 仅实验支持；Windows/macOS/WSL、桌面客户端及其他 Provider 未完成真实验收。此轮 Linux/指定模型留存验收已解除此前 Markdown 发布阻碍，不能据此宣布全环境正式发布。包仍为 `0.2.0`、`private:true`，未发布或切换正式环境。

## 模型名更正后的历史验收（统一网络层之前）

用户将测试模型更正为 **`deepseek-v4-flash-vision-exp`**。测试脚本已固定使用此 ID；之前错误模型名的 HTTP 400 记录仅作为历史，不应用于判断这个模型是否可用。个人配置和 API Key 保存方式未改。

更正后发现第二个明确原因：原维护 schema 的纯字符串 `const` / `enum` 字段省略了显式 `type`，DeepSeek 的 strict schema 解析器以 HTTP 400 拒绝。已在**同一份** `maintenanceSchema` 为这些字段补上 `type: "string"`，没有 Provider 专用 schema 转译，所有合法值和 Core 校验范围保持不变。AJV 前后接受域回归与独立 Review 均通过。补齐后真实请求返回 HTTP 200，证实 schema 拒绝已消除。

| 更正后实验 | 实际结果 |
| --- | --- |
| 原 schema；system / 4096 / 未指定 reasoning | Init 与 Markdown 均 HTTP 400；定位为 schema 缺显式类型 |
| 补类型；system / 4096 / 未指定 reasoning | 两入口均 HTTP 200，但响应正文未在原有 60 秒期限内读完；无提交 |
| 补类型；仅显式 reasoning.effort=none 的单次探测 | 曾出现非法输出 JSON、正文读取失败，均安全拒绝，未修复或放宽输出解析 |
| 完整 smoke，显式 none | **Init 首次尝试成功**，processed，retainedIn 为 preferences/profile，有真实 Writer 提交和持久回执 |
| 同库 Markdown 导入及恢复 | 5 次 Runtime 尝试后仍失败：首次正文超时，随后正文读取失败；第 4 次暂态诊断确认 ECONNRESET；最后一次请求阶段网络不可用，达到原 maxAttempts=5 后为 dead |
| 重启后的无 Key MCP read | 能读到 Init 的 Quillon 等内容，来源可见；未读到未提交的 tide-table |

最终结果是 **真实 Init 链路通过，完整 Init + Markdown 链路仍未通过**。不能把连接重置认定为 Core 校验失败，也不能据此确定故障位于服务端还是中间网络。正文读失败的已知传输代码现在映射为 `UNAVAILABLE / response_body / network_error / retryable:true` 并保留 HTTP 状态；最后一次未收到响应头则是 `request / network_error`。仅匹配四个本地白名单代码，不持久化原消息、地址或 cause，不改变重试调度。

本轮全过程保持 4096 输出预算和 60 秒默认超时；未换模型、自动 fallback、修补非法 JSON、绕过退避或重置尝试次数。`--no-thinking` 仅是 smoke 的显式对照开关，无参依旧不发送 reasoning 配置：

```sh
node scripts/smoke-deepseek-init.mjs
node scripts/smoke-deepseek-init.mjs --no-thinking
```

证据保留于隔离目录：

- 原 schema 的更正模型测试：`/tmp/cm-deepseek-smoke-H9dMyY/report.json`。
- 补类型后的默认思考测试：`/tmp/cm-deepseek-smoke-SK85s8/report.json`。
- 关闭思考的完整 smoke：`/tmp/cm-deepseek-smoke-FqDiLy/report.json`。
- 同一 Markdown 恢复至第 5 次并再次重启 read 的最终状态：`/tmp/cm-deepseek-smoke-FqDiLy/resumed-report.json`。队列有 1 条 processed、1 条 dead；DB 与文件回执各 1 份，均属于 Init。

Init 的 Profile/Preferences Section 明确标注来自 smoke-fixture、saved_memories、合成且未验证。两次重启读取均保留这些内容。现有 Memory 前后摘要仍为 `c4e1a57b4617869cc30b69d1c4e93c76bb0112985bedde2b4f9662ba17ac75a7`，个人 Memory 未修改。

最终复验：完整 `verify` **23 文件 / 260 测试通过**，42 源文件边界检查、类型检查和干净构建通过；构建后 Linux consumer 通过。日志分别为 `/tmp/cm-init-verify-vision-final.log`、`/tmp/cm-init-consumer-vision-final.log`。增量独立 Review 确认 schema 等价、诊断脱敏及显式开关边界，聚焦验证 45 项与后续连接重置 2 项通过。Windows CI、桌面客户端和其他 Provider 的真实调用仍未执行。

## 模型名更正前的历史结论

以下保留用户更正模型名之前的历史实验；不代表更正后模型的结果。实现与自动化验证已完成；当时指定的真实模型写入验收未通过。`https://api.deepseek.com/responses` + `deepseek-v4-flash-exp` + Responses 在本次账户下返回 HTTP 400，安全诊断是 `http / request_rejected / retryable:false`，旧 `issue` 保持 `INVALID_RESPONSE`。错误 code 为已识别的通用 `invalid_request_error`；未记录任意 provider 错误消息或正文。最小 schema 请求、最小普通文本请求也被拒绝；`GET /models` 返回 HTTP 200、列出 3 个模型，但不包含指定 ID。模型清单缺席支持“该模型在当前服务不可用”的判断，不能单独证明具体服务端校验失败的字段或旧请求的全部历史根因。本轮不擅自替换模型。

因此真实 DeepSeek 的 Init、Markdown import **没有**进入模型输出校验与提交，没有持久成功回执。新启动的 MCP read 进程读到空记忆。假模型回归、协议连通与空读取不构成真实 Writer 成功。此项仍是 Init 里程碑交付阻碍。

## 已定位的问题与被推翻的判断

| 问题 | 源码/实验结论 | 处理 |
| --- | --- | --- |
| 构建资源缺失 | 原 `verify` 直接运行 tsc，不清理、不复制 `memory-maintainer.md`；旧 dist 可能掩盖问题 | build 与 verify 共用 `scripts/build.mjs`，清理、编译、复制资源 |
| 错误信息压缩 | 原 adapter 丢弃 HTTP 状态，解析错误共用 INVALID_RESPONSE；Init 只查 observation.issue | 受控诊断贯穿 adapter、Writer、jobs、各入口查询 |
| flush 假成功 | 原失败只打印 JSON，退出 0；退避和别人租约都可能返回 idle | 记录本次失败/取消/隔离并检查最终 pending/claimed/dead |
| Writer 竞争 | 原代码把退休 job 的 done 当作 committed；初版修复仍可能采用旧租约的决策 | 在仓库锁与 DB 事务内恢复并检查真实回执；文件回执表示 committed，仅 DB 回执表示 ignored |
| 终止原因混淆 | 原超时与续租失败都走 cancelled；外层取消还可能丢已收到的 HTTP 状态 | 首个终止原因固定；受控进度上下文保留 HTTP 阶段/状态 |
| demo 数据复用 | 默认 `~/.common-memory` 实际指向 `/home/mrremon/common-memory-test`，本进程 COMMON_MEMORY_HOME 也指向它 | 原保护保留，status 显示配置与真实路径；实验全部用新目录 |

“DeepSeek 不支持 Responses”被官方接口资料推翻；官方文档还明确 `developer` 被视为 `user`。维护提示现用 `system`，原观察仍以独立 user 数据投影传入。角色差异是必须修正的语义问题，不能据此宣称它造成了当前 HTTP 400。[DeepSeek Responses API](https://api-docs.deepseek.com/api/create-response/)

没有证据表明不同 dataRoot 之间串写。现有 Memory 前后逐文件摘要相同；原符号链接和数据均未删除或重写。

## 请求模式与诊断契约

- Responses 保留公开 `OpenAIResponsesMemoryModel`、strict schema、`store:false`；旧配置缺省 Responses。
- 新增 `OpenAIChatMemoryModel`，配置工厂返回 `MemoryModelPort`。Chat 发 `json_object`，完整 schema 放 system 提示，之后同样进入 `validateDecision`、provenance/import 守卫、CAS、租约和提交事务。
- 共用 HTTP、完整请求字节计数与安全扫描、响应限额和有限重试。拒绝截断、工具调用、异常完成、非法 envelope/JSON；拒绝内容仅保留指纹。
- 输出默认 4096、上限 16384。Responses 可选 `reasoningEffort`；Chat 可选 `thinking` 或 `enableThinking`，互斥；未配置不发送。不给任意字段透传、不作品牌检测/fallback/schema 转译，不提高默认超时。
- HTTP 错误正文最多读取 16 KiB / 2 秒，同时服从请求 deadline。读取失败保留 HTTP 状态；网络/正文不配合取消时也会被期限隔离。已知错误 code 或受控 schema 错误前缀映射成更具体的本地 reason，未知错误保持 request_rejected。已知连接重置/超时错误码可映射为 response_body/network_error，保留 HTTP 状态；原始消息与 cause 不持久化。
- `jobs.diagnostic` 是可空 TEXT；`BEGIN IMMEDIATE` 中检查列并 ALTER，显式 INSERT 列名支持新旧库。没有新增错误事件表。诊断只接受本地 stage/reason 枚举、100–599 HTTP 状态和 retryable 布尔值。
- 三类查询关联当前 job，返回 jobId/jobState/attempts/retryAt（Unix 毫秒）。成功 observation 不展示旧 issue/diagnostic；已退休 job 的历史诊断保留。接入层 retryable 不改变 Runtime 的退避、次数或手动 retry 规则。

## DeepSeek 分步实验（更正模型名之前）

只使用 `DEEPSEEK_API_KEY` 环境变量，模型始终固定。使用仓库原合成 Init 内容重建原请求形态；未获得此前失败请求的逐字网络录制，因此不声称是历史请求的逐字重放。

| 实验 | 与对照相比唯一请求参数变化 | 结果 |
| --- | --- | --- |
| 诊断补齐后基线 | developer，4096，未指定 reasoning | HTTP 400，请求拒绝，无回执 |
| 角色对照 | developer → system | HTTP 400，请求拒绝，无回执 |
| 输出预算对照 | system 基线上 4096 → 8192 | HTTP 400，请求拒绝，无回执 |
| 思考对照 | system/4096 基线上 reasoning.effort → none | HTTP 400，请求拒绝，无回执 |
| 最小独立探测 | 同模型，最小 JSON schema / 普通文本请求 | 均 HTTP 400；并非完整维护 schema 或角色改动能解决 |
| 模型清单 | GET /models，只检查指定模型是否出现 | HTTP 200；3 个 ID 中没有指定模型 |

真实构建产物 smoke：`node scripts/smoke-deepseek-init.mjs`。脚本固定 endpoint/model，新建 home 和独立 dataRoot，不写 `.env`。Init 用真实 MCP stdio 进程，Markdown 用真实 CLI，均使用真实 HTTP model 与现有 Writer。Init 失败时不动其 retry，而在第二套新目录测试 Markdown；因此此失败分支不冒充同库成功。读取使用重启后的独立 MCP read 进程，移除测试 Key。

本轮 smoke 退出 1，报告 `/tmp/cm-deepseek-smoke-tvvlXj/report.json`：

| 步骤 | 实测 |
| --- | --- |
| Init | accepted:true → claimed，jobState:retry，attempts:1，HTTP 400 |
| Markdown import | 退出 1，jobState:retry，attempts:1，HTTP 400 |
| 持久回执 | 两个库 DB receipts=0，文件 receipts=0 |
| 重启 MCP read | 工具仅 memory_read/memory_status；两个库均 empty:true |
| 现有 Memory | 前后摘要 `c4e1a57b4617869cc30b69d1c4e93c76bb0112985bedde2b4f9662ba17ac75a7` 相同 |

临时报告只记录枚举、标量、路径、回执 ID 与摘要；不含 Key、原始 HTTP 正文或任意错误消息。合成观察与可能生成的记忆只保留在隔离目录，不清理任何已有数据。探测版摘要只包含文件；最终 smoke 摘要还包含目录条目，不能把这两种算法的摘要直接比较。

## Provider 验证等级

等级针对“端点 + 模型 + 模式”。通用 fake-provider 通过不表示某品牌全部模型兼容。

| 端点 | 具体模型 | 模式 | 本轮证据与等级 |
| --- | --- | --- | --- |
| `https://api.openai.com/v1` | `gpt-test`（fixture；未指定真实模型） | Responses strict schema | 既有路径保留，fake fetch 合约回归通过；本轮无真实 OpenAI 调用 |
| `https://api.deepseek.com` | `deepseek-v4-flash-exp`（历史误写） | Responses strict schema | 旧实验 HTTP 400；不能用于评定更正后的模型 |
| `https://api.deepseek.com` | `deepseek-v4-flash-vision-exp` | Responses strict schema，显式 reasoning.effort=none | 统一网络客户端 + 明确隔离 NO_PROXY 条件下，三轮真实 Init/Markdown 提交、回执、重启读取通过；有模型输出重试，详见本文最新结果 |
| `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | Chat json_object | 官方文档候选；enableThinking:false 可显式关闭思考；本轮无真实调用 |
| `https://open.bigmodel.cn/api/paas/v4` | `glm-4.5` | Chat json_object | 官方直接 API 支持 JSON 输出及 thinking.type；是新增 Chat 路径的独立依据，本轮无真实调用 |
| `https://api.hunyuan.cloud.tencent.com/v1` | `hunyuan-turbos-latest` | Chat | 官方有兼容接口；该精确模型的 json_object 组合尚未证实，本轮无真实调用，不声明支持 |

Qwen JSON 模式与思考开关依据 [Chat API](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions) 和 [结构化输出](https://help.aliyun.com/zh/model-studio/qwen-structured-output)；GLM 依据 [对话补全](https://docs.bigmodel.cn/api-reference/模型-api/对话补全) 和 [GLM-4.5](https://docs.bigmodel.cn/cn/guide/models/text/glm-4.5)；Hunyuan 仅依据 [直接兼容接口](https://cloud.tencent.com/document/product/1729/111007)，不把腾讯 TokenHub 的另一端点能力混用。

## 验证与独立 Review

首轮完整 `node scripts/verify.mjs`：类型检查、42 源文件边界检查、23 文件 / 250 测试、干净构建通过。构建后 Linux `npm run test:consumer` 通过实际 npm pack 中的类型消费、提示资源、Writer、Pi 加载和 CLI 启动。fake-provider demo 也使用新的临时 home；它仅证明机制。

独立只读 Review 使用隔离 fake model/fetch 复现并确认两项残留：P1 竞争 ignore 回执误报 committed、P2 Writer 超时丢已收到的 HTTP 状态。均修复：恢复结果从真实回执导出，模型端受控阶段上下文只补充已知 HTTP 标量、首个终止原因仍固定。新增双方向竞争回执、HTTP 200/503 停滞正文的完整 Writer 测试；另补 Chat 配置通过真实本地 HTTP、Core、回执和读取的 CLI 测试。

最终 `node scripts/verify.mjs` 全部通过：类型检查、42 源文件边界检查、23 文件 / **256 测试**、干净构建。完整原始输出保留于 `/tmp/cm-init-verify-reviewed.log`，首轮输出保留于 `/tmp/cm-init-verify-1.log`。独立短复审另发现新请求沿用上次 HTTP 上下文，已在每次 attempt 开始前清空，并新增 429 → 第二次网络卡住的 Writer 回归。短复审共 5 项聚焦测试通过，确认已报问题均修复，未发现新阻断缺陷。最终构建后再次运行 Linux `npm run test:consumer` 通过，实际打包产物验证了新增 Chat/诊断公开类型，输出保留于 `/tmp/cm-init-consumer-reviewed.log`。此前一次新增测试 fixture 的 typecheck 失败为缺少 chunk 的 headingPath/bytes，已按实际类型补齐；未改契约来迁就测试。

Windows 原生 CI、本次真实 Windows/WSL 客户端、ChatGPT 桌面 GUI、Codex/Pi 使用远程模型回答及其他 Provider 真实调用均未执行。Linux 检查与 MCP SDK 子进程证据不覆盖这些项。此前历史实验见 [原验收记录](init-v0.1-verification.md)。
