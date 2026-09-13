# 会话接入：当前实现与验收边界

2026-09-09。此文替代历史记录中的 Pi 六条触发、每轮自动读、Codex 只读 Hook
及退出只排队的描述。Canonical Markdown、Core 写权限和 MCP stdio 固定 capability
没有改变；没有新增检索、索引、长期记忆 revision、监听同步或一致性协议。

## 持久状态与处理链

`src/v2/session.ts` 提供 SessionIngress：open、capture、settle、seal、end、status。
身份是 client（pi/codex/chatgpt-work）＋processInstance＋真实 session ID 的摘要；真实结束后再启动附加独立 activation 标识，cwd 只用于范围选择。
SQLite 增加 sessions、session_turns、session_messages、session_batches；旧 observations、
leases、jobs、receipts、associations 继续承担队列与恢复职责。迁移幂等且事务化。
用户正文存在 observations 一处，session_messages 只存其引用；assistant/tool 正文
只作为上下文缓存。每条消息有稳定身份、角色、来源、顺序和摘要；重放相同消息是
no-op，冲突拒绝。一个交互必须含实际已交付用户表达；候选输入不算轮。

满十次 settled（含终止后的 interrupted）即原子封逻辑批次。未满十轮保持 buffered，
不受 legacy 六条/字节/idle/flush 触发；退出将 open 标为 incomplete 并封尾。
关闭屏障由 sessions.closing 与该 session 全部观察的持久状态共同构成。
complete 要求 closing、全部处理成功且不存在 incomplete 回合；dead/quarantined
或未完成尾轮保留 incomplete。模型服务的永久认证、配置和协议错误不自动重复请求，首个失败即 dead，保留输入供显式 retry；瞬时网络错误仍按退避和次数上限处理。宿主取消保留可恢复工作，Core 决策校验失败仍可重新生成决定。
空尾不制造证据。status 命令列出各 session 汇总，
不打印正文；显式 retry 后状态可重新计算，不存容易失真的成功标志。

Writer 的 `conversation_turns` 保留整轮消息关系。当前用户表达仍各自获得 ev 引用；
assistant、工具、前轮上下文都是 context_only，不能单独作为 retain/forget 证据。
跨批尾上下文通过旧 turn/observation 引用读取，无永久正文副本。forget、人工改文档
导致来源失效、processed prune 都通过 SQLite trigger 同步清空同轮 assistant/tool
正文；重放同身份不会复活正文。敏感上下文记录不可用；用户正文仍由既有 Writer
安全扫描保护。引用、建议不会被预处理提升为用户确认。

`conversation_context` 是单独披露权限，旧配置不会自动获得。未授权时会话请求包含
不可用原因，legacy 前轮上下文也不再发送，不用 user_explicit 绕过。contextTailTurns 默认 2，最多读取同 session、
同 scope 的已处理回合。Writer 先舍弃可选历史上下文，再按整轮拆请求；单轮连同
用户确认与相关上下文仍超限则整轮隔离并保留正文。session、legacy relay 和两类
import 不混批，模型输出仍是 memory_maintenance_v2。

可选 sessionCache 默认 maxSessionBytes=8 MiB、maxTotalBytes=64 MiB、contextTailTurns=2。
数字是保守工程默认，没有容量实证或远距离指代充分性保证。正文容量包含候选输入、
交付缓存、session 正文、待交接 Codex/Work inbox 和唯一 host_snapshots 正文。超限事务回滚，保留已有数据及位置，
终止信封无需新增正文空间。摘要、状态、receipt 等元数据不计入正文容量。

## 宿主适配

Pi（事件契约验证基线 0.84.4；安装与发现不按版本号限制）：`src/pi-extension/` 保留来源候选匹配、变换/混合来源隔离、稳定 Entry
绑定。最终 agent_settled 封口；tool loop、retry、compact 不计数。真实 quit 才 end，
reload/new/resume/fork 的 extension shutdown 只关闭本地资源。进程随机身份与附加
记忆块通过 globalThis 保留跨 reload 状态；数据Root＋session 冻结附加块，每轮与
当时的宿主 systemPrompt 组合。startup 读一次，后续生命周期不补读；原生 memory_read
及 promptSnippet/promptGuidelines 按当前授权主动读取。Pi 直接写公共 ingress。configured Writer 先构造精确请求序列化器和本地 SQLite，
首次维护请求才初始化固定网络路由、CA 和 dispatcher；初始化失败保留持久工作，绝不改走直连。
Pi 捕获/维护诊断只打印受控原因与修复入口；相同原因去重，每个报告器最多八种，不打印异常正文。

Codex host：`src/cli/codex/transcript-codex-host.ts` 独立解析 rollout。最低版本 0.153.4，
接受严格三段数字版本且无上限；不接受 prerelease/build 标签。以 0.153.4/0.154.0 tagged
源码为结构基线，未知顶层、event_msg、TurnItem、UserInput、response_item/role 判别值拒绝。
0.154.0 的 retained_context 仅为非证据记录。user_message 与 item_completed/UserMessage 是交付来源；world_state、token_usage_record 为非证据记录；response_item 中环境、hook
和 compact 重放的 user 消息不成为证据。task_started 分组，task_complete 或
turn_aborted 确认终态；接受官方等价别名 turn_started / turn_complete（[0.154.0 protocol.rs](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/protocol/src/protocol.rs) 的 serde alias）。
Stop/Interrupt 只登记核对，不假定其时 transcript 已写终态。
UserPromptSubmit 候选按 session/turn/digest 独立保存并冻结输入时的 scope，user_message 必须精确匹配；tagged protocol.rs 的 legacy UserMessageEvent 不含 turn_id，
仅可在明确 task_started（或官方别名 turn_started）的单一 active turn 内绑定；若提供 turn_id 必须完全匹配。
item_completed 与终态必须带匹配的非空 turn_id；证据/终态时间戳必须有效。
匹配成功在同一事务清空候选正文并转存交付，保留摘要用于重试。候选不当作已交付证据，
也不作为自动记忆返回正文。无法匹配时保留 inbox，明确报告未确认交付。

`src/cli/host-session.ts` 是 Codex/Work 共享 adapter（codex-session 保留兼容导出），将尾部 JSONL 正文和信封放进同一 runtime.sqlite 的 durable
inbox，SQLite WAL＋synchronous=FULL 提供原子、fsync 持久性。Hook 使用 150ms SQLite
busy timeout，生成器给三秒宿主期限；不在 hook 内运行模型。首次合格 startup/resume 读取有界快照；普通轮次不重复追加。compact/clear/reload 只重挂缓存。显式刷新由 PostToolUse 或下一 UserPromptSubmit 交付。进程身份取 Linux/WSL boot ID＋Codex 祖先进程 PID＋
启动时间；PID 复用和不同工作目录不会错误共享 session。低于最低/非数字版本、未知结构、路径替换、未确认交付、
尾部不完整或容量不足均显式失败，不前移消费位置。SessionEnd 快照不依赖退出后文件存在。

`src/cli/session-drain.ts` 使用 detached＋独立 stdio＋unref 启动真正的 configured Writer。
它先事务性将 inbox 正文转为 session 状态，同事务删除副本；Stop 核对会继续读取后续
终态记录，不等待下一输入。单次核对最多 60 秒，失败保留 durable watch。消费者使用
`src/v2/session-drain.ts` 等待正常租约、退避，直到已封工作处理或 dead/quarantined。
消费者崩溃后可由下一次写端事件或 `common-memory session-drain` 恢复；不会清空数据。
父宿主与 MCP 退出不会撤销独立消费者。kill、重启、磁盘失败不承诺正常结束保证。

两端共用 `src/v2/read-guidance.ts`。缺少用户背景/偏好/兴趣/目标/工作方式/项目约束时
主动读，例如个性化最优化课程推荐、按研究方向比较项目；普通梯度下降解释或已具备
充分个人上下文不机械读。contextId 只选授权范围，空结果不是负面个人事实，缺项未知。

## 验收证据与限制

- `tests/v2/session.test.ts`：A/B 各九轮隔离，第十轮 settled 即可领取；21 轮形成
  10＋10＋1；steering、重复交付/封口、容量回滚、incomplete 尾轮、混合来源隔离、
  独立上下文权限、forget 清理后重放不复活、完整回合拆请求和真实退避等待。
- `tests/cli/codex-hook.test.ts`：一次启动读取、新进程恢复、compact 不补读；Stop 重复
  且终态延迟写入；排除 response_item 用户环境文本；删除 transcript 后仍交接尾批；
  未知格式保留 inbox、版本拒绝、部分行拒绝、输入/快照上限、五种事件配置。
- `tests/v2/pi-integration.test.ts` 和 `pi-sdk-capture.test.ts`：真实 SDK 合成 provider 及
  事件级十轮/尾批、网络不可用时仍持久捕获、诊断去重；保留交付认证、队列来源、图片隔离；冻结附加块与
  宿主新 systemPrompt 组合、reload 保留快照。
- `tests/cli/session-drain.test.ts`：实际 Node 宿主退出与 MCP EOF 后才释放本地假提供者，
  独立消费者仍提交 canonical Markdown、receipt 与完成状态；强杀消费者后显式重启恢复。
  这不是只验证 Node 子进程能存活，而是执行实际 configured Writer 与 Core 提交。

## Work、activation 与刷新

TUI 选择 ChatGPT 后自动安装本地 Work 的六个 Hook、显式 refresh skill，并保留原有 read MCP。
默认不增加导入能力；v0.3.8 起可在 TUI 显式选择独立 `memory_init` 接入，并单独确认尚未授予的
`agent_observation` 披露权限，与安装事务一起保存。Core 来源与固定 capability 边界不变。
macOS 用绝对 POSIX 启动；
Windows Desktop 从 WSL 安装到原生 Windows 配置目录，同时写入带 UTF-8 BOM 的 PowerShell 桥接。
不会探测/捕获网页或普通 Chat。已有受管理只读安装重新确认原选择即可事务性补齐；修改或缺失
仍保留的资源、显式 hooks=false、未归属捕获定义和不安全路径会中止，不接管用户配置。

同一配置根、运行模式、Common Memory home/runtime 的 Codex 和 ChatGPT 共享一组物理 Hook、
skill 和 Windows bridge，添加/移除一方不改变捕获/刷新身份。官方 Hook 输入不认证前端产品，
所以自动安装均标记内部 `client=codex`，表示 **Codex host 协议**，不声称来自某个前端。
最后一个 owner 离开才移除共享资源；不从 Hook 祖先或 owner 数推断产品身份。
手动 `work-config` 仍保留明确选择的 `chatgpt-work` 身份及既有独立 init 配置，
其导入仍需原有审批和披露授权。自动可选 init 使用稳定 `common-memory-local-init` identity，
不冒充旧手动 `chatgpt-desktop` 的导入来源或 receipt。不能与同根自动捕获配置叠加安装重复 Hook。

host_activations 在同一 Runtime 保存 client、原生宿主实例、真实 thread、cwd 和 active
状态；host_snapshots 只有每个 activation 的唯一正文 slot 与 pending 标志。真实
SessionEnd 入队时关闭 activation 并删除 snapshot，不提前关闭待消费 session 或删除
尾批。再次合格 startup/resume 创建独立 session key。unsubscribe 不映射 SessionEnd。
刷新依赖宿主祖先进程身份及 CODEX_THREAD_ID，无法唯一定位就失败；读取和替换在同一
事务中，容量失败也回滚。普通 memory_read 不接触该 slot，read MCP 不打开 Runtime。
同进程 resume 不重读；compact/clear/reload 重挂已有块；新进程首次 resume 自动读取。

`work-config --mode posix|windows-wsl --output <absolute-directory>` 生成可检查配置、
显式 memory-refresh Skill 和必要的 PowerShell bridge。无法从环境确定 agent 模式时
要求选择，不用终端类型或 WSL_DISTRO_NAME 代替。`codex-config` 同样支持 bundle 参数，
无参数继续打印 profile。共用 host-launch 固定 Node、CLI、home 与 WSL distro/user。
Work 的 read 和 init 分进程；init 保留 chatgpt-desktop identity，Codex profile 禁用 init。
所有 Hook 均保留宿主信任机制，不写信任 store、不生成绕过选项。
自动 JSON 与手动 TOML 共用事件配置：仅 SessionStart、UserPromptSubmit、PostToolUse 设置
`additionalContextLimit = 0`，保持完整快照交付；Stop、Interrupt、SessionEnd 不写该字段，
也不返回 additionalContext，避免 Codex host 的不支持事件告警（[0.154.0 discovery.rs](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/hooks/src/engine/discovery.rs#L539-L556)）。
v0.3.6 升级到 v0.3.7 后，在 Agent Integration 保留原选择并按 Enter 应用，事务性替换旧受管理配置；
共享 owner 与无关 Hook 保留。手动安装者需重新生成并审阅 bundle；仅升级 npm 包不会改写已有配置。

Windows bridge 从原生祖先进程读取 PID/CreationDate，转换 cwd/transcript 路径，使用
UTF-8 STDIO 并保留退出码；生成 ps1 含 UTF-8 BOM，兼容 Windows PowerShell 5.1。
启动器宜安装到 Windows 本地路径：UNC 脚本可能被本机签名策略拒绝，生成器不改策略。
macOS 直接使用绝对 POSIX 启动参数，身份取 ps 的 PID/启动时间。WSL 内的 agent 使用
直接 POSIX 模式。Linux 检查不代表 Desktop 在 Linux 上的产品支持。

新增 `tests/cli/work-session.test.ts` 验证 A→B 刷新后 canonical C 不渗入、空 prompt
显式 Skill 路径、重复刷新、失败/容量回滚、客户端/线程/进程/重新启动隔离、十轮
item_completed 交付及旧格式去重、未确认内容保留 inbox、配置与 Skill invocation policy。
`node scripts/smoke-work-bridge.mjs` 是构建后的 Windows→WSL 合成宿主实测入口，使用
本地假提供者执行 configured Writer/Core；无真实模型调用或个人资料。

协议依据：[官方 Hooks](https://learn.chatgpt.com/docs/hooks)、
[官方 MCP](https://learn.chatgpt.com/docs/extend/mcp)、
[Windows agent 环境](https://learn.chatgpt.com/docs/windows/windows-app)。
rollout 不是稳定公共接口，新数字版本可按已知结构接入；新判别值需要新适配与新验收。

真实 Desktop UI 的 Hook 信任、真实模型主动读取与完整真实客户端事件组合尚未验证。
macOS 本轮只有逻辑与配置生成验证，真机验收留给后续测试者；Linux 测试不证明 Windows CI。

历史验证（此前实现，Node 24.20.0）：`node scripts/verify.mjs` 通过 typecheck、58 源文件边界
检查、32 测试文件 / 387 项测试和 build；构建后 `npm run test:consumer` 通过真实
tarball typed consumer、prompt asset、Writer、Pi load 与 CLI startup。生成的 Work
和 Codex Skill 均通过 skill-creator quick_validate，invocation policy 另由测试断言。
Windows PowerShell 5.1 → Ubuntu WSL 的合成宿主测试验证 Unicode STDIO、原生实例
身份、路径转换、A→B 刷新不被 C 覆盖、退出码，以及父宿主退出后 configured Writer/Core
提交 canonical Markdown；同脚本还独立验证直接 WSL 祖先进程身份及启动读取。
此项是合成宿主的真实跨边界执行，不等同于 Desktop UI 验收。

### v0.3.6 回归覆盖

网络默认路由、Pi 捕获与诊断、Codex 新版本/未知结构、Work 保留项升级均先有失败回归。
`tests/v2/pi-sdk-capture.test.ts` 通过真实 Pi SDK 和合成 provider 验证交付、持久化、十轮封批与退出尾批，
并验证维护网络不可用时仍能捕获；开发依赖基线为 Pi 0.84.4，另在本机 Pi 0.85.1 SDK 下验证。
`tests/cli/codex-hook.test.ts` 覆盖官方 task_* / turn_* 等价回合事件、候选匹配及未知结构保留队列。
`tests/cli/integrations.test.ts` 覆盖默认自动接入不新增 init 权限、已有只读接入升级、共享资源及安全卸载。
v0.3.8 新增 `integration-init.test.ts` / `integration-probe.test.ts`，覆盖显式 init 选择与披露事务、
macOS GUI/CLI 根分离、真实只读 MCP 握手与超时；TUI / uninstall 回归覆盖取消、能力保留及 profile 残留检查。
`npm run test:wsl` 使用安装后的包验证 PTY、只读 MCP、自动共享 Work/Codex 资源及原生合成宿主的
Unicode/路径/刷新/退出码和 Writer/Core 提交；它不代表真实 Desktop UI 的 Hook 审查或完整交互验收。
精确发布提交及最终验证结果保留在对应 GitHub Release 和 CI 记录中。
