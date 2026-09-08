# Provider 验证复用 — 2026-09-08

结论：把现有 DeepSeek smoke 的输入改为现有 `remote` 配置，复用原来的一个留存场景。主要重复成本在隔离目录、真实 CLI/MCP/Writer 调用、退避等待、回执核对、重启读取和结果整理；Responses / Chat adapter 与统一网络层已经可以复用。本轮不修改生产 adapter、配置契约、网络层、Core 或提示，不建立 provider registry、preset 或 capability framework。

## 搜索证据与设计决定

核对了当前两个 adapter、config/network、fake-provider 合约测试，以及 [DeepSeek 最新闭环记录](init-v0.1-closeout.md)。下列官方资料于 2026-09-08 查阅；文档支持只建立候选条件，不能代替具体账户、模型和端点的真实验收。

| 官方证据 | 对设计的实际影响 |
| --- | --- |
| [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)：JSON mode 不保证 schema，strict 只支持 JSON Schema 子集 | 保持两条现有请求路径及完整 Core 校验。HTTP 200 或 JSON 可解析不能成为留存通过条件；不转换 schema 来隐藏拒绝 |
| [DeepSeek Responses](https://api-docs.deepseek.com/api/create-response/) / [指南](https://api-docs.deepseek.com/guides/responses_api/)：支持指定 vision-exp 模型；`developer` 按 user 处理；`reasoning.effort=none` 可显式关闭思考 | 现有 system 提示和 `reasoningEffort` 已够用。保留原模型及对照入口，不增加品牌分支或默认思考参数 |
| [Qwen 结构化输出](https://help.aliyun.com/zh/model-studio/qwen-structured-output) / [Chat API](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)：JSON 能力受模型与思考模式限制；端点按地域/工作空间变化，旧 DashScope 域名仍可用 | 候选 Chat 请求可以使用现有 `enableThinking:false`；端点必须由验证者明确提供，不固化品牌 preset。[Qwen Responses 文档](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses)也已存在，不据此推断某个 Chat 候选模型支持 Responses |
| [GLM 对话补全](https://docs.bigmodel.cn/api-reference/模型-api/对话补全) / [结构化输出](https://docs.bigmodel.cn/cn/guide/capabilities/struct-output)：`json_object` 配合提示定义结构，仍需本地校验；支持显式 thinking 配置 | 现有 Chat adapter 的完整 system schema + Core 校验已经覆盖这项差异。当前结构化输出示例使用 `glm-5.2`，不能证明历史候选 `glm-4.5` 仍可用，也不自动替换候选 |
| [Hunyuan 直接兼容接口](https://cloud.tencent.com/document/product/1729/111007)：列出旧端点和 `hunyuan-turbos-latest`，同时公告向 TokenHub 迁移；旧平台不再新增模型能力，已购服务暂不受影响 | 不把 TokenHub 的另一个端点能力套到旧接口。此页未确认该组合的 `json_object`，保留未验证；不添加所谓 Hunyuan 特殊处理 |

Hunyuan 页面经网页工具多次读取失败后，用 HTTPS 直接获取官方 HTML（HTTP 200）核对，页面标注更新于 2026-04-27。没有把读取失败当成 API 不支持。现有代码与上述证据已经确定了复用边界，未引入开源兼容框架。

## 最小实现

[`scripts/smoke-provider.mjs`](../scripts/smoke-provider.mjs) 接受一份**现有完整 schemaVersion 2 配置**，由现有 `validateConfig` 校验，只将其中 `remote` 复制到全新的临时 home / dataRoot。其余使用默认配置，并明确授权合成的 `agent_observation` 和 `document_import`。输入配置和原存储不被修改，原 Memory 只读取摘要。保留原 smoke 的固定场景与 Runtime 退避，不强制接管租约、不重置任务、不放大默认 60 秒 Writer 期限或 4096 输出预算。

测试配置必须明确指定 `remote.proxy`：`direct` / `env` / `custom`。旧配置在产品内继续保留 legacy 语义，但验收需要一条可说明的路线；可以仅在测试副本中选择网络模式。通用入口默认继承 NO_PROXY；只有显式 `--clear-no-proxy` 才清空子进程中的大小写变量，报告记录该条件。进程环境不被修改。custom/CA 仍由现有网络层处理。

API Key 从 `remote.apiKeyEnv` 指定的**进程环境**读取。个人私密 `.env` 不复制到临时 home；custom proxy 和 CA 所需的环境引用也应事先注入进程环境。配置与报告只包含环境变量名，不保存 Key、代理凭据或原始 Provider 错误正文。

报告绑定完整端点、模型、API、允许的输出/思考参数、Node/平台、配置路线描述、维护 schema 与提示的 SHA-256，并保存尝试状态、受控诊断、来源关联、回执 ID、重启读取标记及正式 Memory 前后摘要。路线字段描述配置选择，本身不证明连接成功。`report.json` 留在脚本打印的临时路径，临时测试数据不会自动删除。

成功必须同时满足：

1. Init 和 Markdown 每个分块均 processed，且 `retainedIn` 非空。
2. 每个来源对应的 job 都有匹配的 SQLite 回执和文件回执；不使用回执总数或 `job.state=done` 代替。
3. 两种导入在同一新库完成；移除所选 API Key 后启动新的 MCP read 进程，仍读到 Quillon、Fedora、fish。
4. 正式 Memory 摘要不变，流程没有失败步骤。

Init 失败时，仍沿用原 smoke 在第二个新库检查 Markdown 的行为，以保留诊断；两个库各自的局部成功不能合并为闭环通过。`ignore` 是合法处理结果，但本场景要求留存，因此判为留存未通过。

证据来源必须显式选择 `--live` 或 `--fixture`。只有 `--live` 且上述检查全部通过才记录 `retentionVerified:true`；fixture 完成完整流程也只记录 `passed:true, retentionVerified:false`。这个标记是运行者对远端性质的明确声明，不是自动识别或认证 Provider 品牌。退出码：通过 0、已执行但未通过 1、配置/构建等启动失败 2。

[`scripts/smoke-deepseek-init.mjs`](../scripts/smoke-deepseek-init.mjs) 已缩为兼容入口，调用同一实现。原命令、精确模型、env 路线及隔离清空 NO_PROXY 的测试条件保留；无参仍省略 reasoning，`--no-thinking` 才发送 `none`。没有添加依赖、任意请求参数透传、API/model fallback 或另一套配置 schema。

## 下一家 Provider 最少需要什么

1. 依据官方文档与账户权限，确定**端点 + 精确模型 + 请求模式**。复制一份有效配置，只在副本中调整 `remote.baseUrl`、`model`、`api`、`apiKeyEnv`、明确的网络模式和已有允许参数；不把 API Key 写入文件。
2. 将 Key 和必要的网络秘密安全注入当前进程环境。无需再写或复制一份 smoke 脚本。
3. 从源码 checkout 构建并执行：

```sh
npm run build
node scripts/smoke-provider.mjs --config /path/to/provider-config.json --live
```

`--clear-no-proxy` 是有记录的显式测试条件，仅在确实要测试该路线时添加。不要为了让测试通过自动改变 endpoint、模型、模式或参数。若返回诊断失败，先记录原条件与失败，再一次改变一个有官方依据的参数重测。成功后归档打印的 `reportPath`，按精确组合更新下表；同品牌其他组合继续保持未验证。

这一个固定合成场景证明导入留存链路，不能替代所有记忆决策的语义评测、长文档测试或真实桌面客户端验收。

## 当前证据等级

区分“官方文档候选”“fake 合约/流程通过”“真实 API 或 adapter 成功”“真实留存闭环通过”。后三者不能互相冒充；本轮没有新增一个仅 API 成功的 Provider。

| Provider / 精确组合 | 当前证据 |
| --- | --- |
| OpenAI；Responses；未指定真实模型 | 通用 fake adapter 合约通过；没有该官方端点与真实模型的调用或留存证据 |
| DeepSeek；`https://api.deepseek.com/responses`；`deepseek-v4-flash-vision-exp`；strict / reasoning none / 4096 | **真实留存闭环通过**。此前三轮独立验收，本轮兼容入口重构后追加一轮成功；仅覆盖所记录的 Linux / env 代理 / 空 NO_PROXY 条件 |
| Qwen；历史候选 `https://dashscope.aliyuncs.com/compatible-mode/v1` + `qwen-plus`；Chat / json_object / enableThinking false | 官方文档候选；精确账户、地域端点、模型和留存尚未真实验证 |
| GLM；历史候选 `https://open.bigmodel.cn/api/paas/v4` + `glm-4.5`；Chat / json_object / thinking disabled | JSON 请求模式有官方依据；该历史精确模型的当前可用性与留存仍未验证。`glm-5.2` 只是本次查阅的官方示例，不是悄悄替换后的通过项 |
| Hunyuan；`https://api.hunyuan.cloud.tencent.com/v1` + `hunyuan-turbos-latest`；Chat | 官方直接接口候选；精确模型的 JSON object 支持、迁移后的账户可用性及留存均未验证 |

本轮新增的本地 Responses / Chat 完整 fake 流程只验证脚本和真实 Writer/Core 的连接，不提高上述任一品牌的验证等级。

## 本轮验收

Node `24.20.0` / Linux。重构后的真实 DeepSeek 命令：

```sh
node scripts/smoke-deepseek-init.mjs --no-thinking
```

运行时间 `2026-09-08T00:45:50.425Z` 至 `00:45:58.421Z`；报告 `/tmp/cm-provider-smoke-IECYBh/report.json`。Init 和 Markdown 各一次 Runtime 尝试成功，六项检查全部通过，`retentionVerified:true`。两个匹配的 DB/文件回执 ID 为 `7a7bbc7a-014a-4f9c-9898-8c1c42e1489e`、`85eed726-820d-4901-b4eb-6d62ae056bfc`。正式 Memory 前后 SHA-256 均为 `c4e1a57b4617869cc30b69d1c4e93c76bb0112985bedde2b4f9662ba17ac75a7`。

该次维护 schema SHA-256：`abba185086bf8ffac0a99a8415a15e98b92d7ab6101998bbb1a3aa12056a473d`；提示 SHA-256：`9a1bd9709694aba8803d350b83ff5d0b8f01d288768f7e05b16859428ea666fe`。

聚焦验收覆盖 CLI 参数、来源关联回执、部分处理、ignore、缺失读取标记、正式存储变化，以及构建产物上的 Responses / Chat 真实本地 HTTP → CLI/MCP → Writer/Core → 回执 → 重启读取。无需真实 Key 的构建产物回归单独执行：

```sh
npm run build
npm run test:provider-smoke
```

此命令采用 Node 内置 test runner，类似 `test:consumer`；需先构建，不隐式加入构建前的 Vitest gate。纯判断与参数测试包含在正常 Vitest suite 中。

本轮结果：2 个 Vitest 文件 / **44 项通过**（新增脚本判断 14 项 + 既有 Chat/诊断 30 项），构建产物集成 **3 项通过**，typecheck、构建、脚本语法、`git diff --check` 和本地文档链接检查通过。最终日志为 `/tmp/cm-provider-smoke-focused-final.log`、`/tmp/cm-provider-smoke-integration-final-2.log`、`/tmp/cm-provider-smoke-typecheck-2.log`、`/tmp/cm-provider-smoke-build.log`。新增参数表测试最初有 TypeScript 的 `it.each` 回调签名错误，原输出保留于 `/tmp/cm-provider-smoke-typecheck.log`；改为对象行后复验通过，未改产品类型。

按本轮修改范围，未重跑上一轮完整 341 项 gate 或 Linux consumer；本轮未改包导出及生产源码。Windows/macOS/WSL、桌面客户端及其他 Provider 的真实请求仍未执行。
