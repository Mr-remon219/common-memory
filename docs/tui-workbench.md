# Common Memory 交互工作台

## 设计判断与调研依据

统一的是用户的操作旅程，不是协议、宿主生命周期或授权来源。默认运行
`common-memory` 打开一个持续运行、可以返回的任务工作台；自动化命令和协议
入口继续存在。采用已有 Clack 的菜单、表单、分页查看，不引入全屏渲染框架、
第二份业务实现或新的后台服务。

本次调研核对了以下官方／项目一手文档，设计借鉴不等于性能实测：

- [Command Line Interface Guidelines](https://clig.dev)：人类优先但保留组合能力；
  仅在 TTY 提示；明确确认危险操作；取消不能伪装成功。
- [Lazygit 导航](https://lazygit.dev/docs)及[项目快捷键](https://github.com/jesseduffield/lazygit/blob/master/docs/keybindings/Keybindings_en.md)：
  以当前对象和任务组织操作，导航／上下文动作可发现。借鉴分区和逐层进入，
  **不**照搬 Git 面板、快捷键数量或 Undo 能力。
- [Clack Prompts](https://bomb.sh/docs/clack/packages/prompts)：沿用 select、
  multiselect、text、password、confirm 和 cancel。API 与取消键同时核对了本地
  已安装的 `@clack/prompts` 类型声明和 `@clack/core` 实现。
- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)：非托管 Hook 必须通过宿主
  `/hooks` 检查和信任；多个来源的 Hook 可以同时运行，生成文件不等于启用。
- [MCP stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)：
  stdout 只能传协议消息，不能混入 TUI 提示。
- Pi 官方安装包中的完整 `README.md`、`docs/packages.md`：本地 package 使用
  `pi install <path>`／`pi remove <path>`；`pi list` 检查注册，`pi config` 管理资源。
  工作台交给 Pi 自己执行这些命令，不实现另一套 Pi settings/trust 编辑器。

阅读本仓库 `AGENTS.md`、README、[架构](03-target-architecture.md)、
[会话接入](session-integration.md)和 CLI/MCP/Pi/宿主适配代码后，确认以下边界：
Markdown 是事实来源；Runtime SQLite 是持久队列，不是可重建索引；TUI 不增加
写权限、检索、跨项目读取、导入的用户证据地位或 MCP capabilities。

## 原入口清单与归属

| 原入口 | 性质 | 工作台位置／保留理由 |
| --- | --- | --- |
| 无参数 TUI：Status/API/Network | 人类入口 | 改为完整 Home 和六个任务分区 |
| `config`、`config --network` | 人类表单快捷入口 | Settings；保留直接表单快捷方式，非 TTY 明确失败 |
| `status`、`show` | 人类＋自动化 | Overview、Memory；保留脚本输出，查看走同一业务函数 |
| `import` | 人类＋自动化 | Memory 导入向导；仍调用同一 Writer 入队／处理路径 |
| `project register/list/remove` | 人类＋自动化 | Projects & permissions；CLI 参数和注册语义保留 |
| `retry`、`flush` | 运维＋自动化 | Maintenance；保留脚本退出码、正常退避和租约行为 |
| `network-test` | 显式诊断＋自动化 | Settings；用户确认后才发合成请求 |
| `mcp-config` | 配置生成＋自动化 | Integrations 预览／导出；继续提供 stdout TOML |
| `codex-config`、`work-config` | 配置生成＋自动化 | Integrations 预览／导出 bundle，CLI 继续支持无人值守生成 |
| `mcp` | **机器协议** | 保留独立 stdio，固定 relay/init/read；不得显示 TUI |
| `codex-hook`、`work-hook` | **宿主 Hook 协议** | 保留 JSON stdin/stdout、持久 inbox 和宿主身份 |
| `session-drain` | **机器消费者**＋显式恢复 | 保留 detached 使用；工作台可前台启动同一入口并等待结果 |
| `session-refresh` | **宿主身份相关操作** | 保留显式 Skill 命令；不能由 TUI 用 cwd 猜测活动会话 |
| Pi Extension、`memory_read`、`/memory-flush`、`/memory-refresh` | **宿主生命周期／会话内交互** | 保留原生入口；外部工作台不能替换它们的会话上下文 |
| Codex/Work 的 `/hooks`、宿主 MCP 设置 | **宿主所有的信任和启停** | 工作台提供安装／停用说明，不修改 trust store |
| 本地 `config.json`、private `.env`、Canonical Markdown | 用户所有的文件 | 不隐藏、不迁移、不删除；设置表单复用配置验证和私有文件写入 |

没有删除已有命令；CLI 和 TUI 是同一产品的两种操作方式。

## 最终信息架构

```text
common-memory
  Home（当前 model/API、dataRoot、导航提示；未配置时只提供配置和退出）
  ├─ Overview
  │   ├─ 配置／真实存储路径／密钥是否存在／网络选择（不是连通性结果）
  │   └─ 队列摘要、刷新、转入维护
  ├─ Memory
  │   ├─ 选择 global／已注册项目 → 文档 → 分页查看
  │   └─ Markdown 导入：文件、范围、作者、标签、处理方式 → 确认 → 结果
  ├─ Projects & permissions
  │   ├─ 注册、项目详情、只移除注册
  │   └─ 独立选择 disclosure scopes、writable scopes、provenance
  ├─ Integrations
  │   ├─ 本地就绪条件（宿主状态明确标为未验证）
  │   ├─ Pi：确认后交给 pi list/install/config/remove
  │   ├─ Codex：会话 Hook + read MCP + 显式 refresh Skill bundle
  │   ├─ ChatGPT Work：会话 Hook + 独立 read/init MCP + refresh Skill bundle
  │   └─ MCP-only：独立 init/read 配置块预览／导出
  ├─ Maintenance
  │   ├─ 队列／job 诊断／dead job retry／无正文 session 摘要
  │   ├─ flush：处理队列，不封未结束的会话尾批
  │   └─ session-drain：恢复持久 handoff，等待正常租约／退避
  └─ Settings
      ├─ model、显式 API 模式、可选密钥更新
      ├─ network、proxy、CA；单独确认的合成连通测试
      ├─ 授权（复用同一表单）
      └─ advanced：输出／thinking 参数、调度／cache／字节限制、切换 dataRoot
```

高级参数在工作台内编辑受验证的 JSON 对象，不引入另一份参数 schema；切换
API 会说明并清除不兼容的 thinking 参数，其他设置保留。切换 dataRoot 是
**选择另一个 store**，不是迁移，需要先停止客户端；原 Markdown/SQLite 不动。

上下键、Enter 和多选 Space 沿用 Clack；每个分区有 Back。表单 Esc/Ctrl+C
返回当前分区，分区菜单取消返回 Home，Home 取消退出。操作失败留在分区内显示，
不污染下一次操作的退出码。只在 stdin 和 stdout 都是 TTY 时打开界面；无参数
非 TTY 输出入口说明并退出，直接配置表单非 TTY 报错，不等待输入。

文档查看是同一次授权读取的分页快照，重新打开 Browse 获取新内容；没有检索、
排名、跨项目汇总或直接编辑 Canonical 的新接口。终端控制字符可见转义，只影响
TUI 呈现，原 Markdown 和消费者／CLI 原文不变。状态只显示计数、ID 和受控诊断，
不打印用户、assistant/tool、inbox 正文。现有 Runtime 存在时状态路径仍通过
RuntimeStore 打开，可能执行其已有幂等 schema 初始化；不是全新的数据库只读模式。
Runtime 不存在时不创建它。MCP read-only 进程的“从不开 Runtime”边界不变。

## Integration management 的界限

生成前必须自行选择宿主运行环境（同一 POSIX 或 Windows→WSL），不能仅根据
`WSL_DISTRO_NAME` 推测桌面进程在哪里。可选项目来自本地 registry，未授权项目有
明确提示，生成过程不自动添加授权。配置、Skill 和可选 PowerShell bridge 均可
分页预览；确认后才写文件，不携带 API key 或代理秘密。

工作台 bundle 选择新目录；自动化生成器仍兼容已有目录，但先检查所有目标文件
是否冲突、bundle 内目录是否为 symlink，再开始写文件，使用独占创建，不覆盖
旧文件。检查到后面的 Skill 文件冲突也不会先写前面的 TOML。磁盘中途失败可能
留下部分新 bundle，需要检查错误并使用新目录重试，不假装全部成功。

Codex/Work/MCP 的宿主配置合并、Hook 信任、MCP 启停仍由宿主所有者完成。
工作台提供步骤和移除说明，没有通用宿主配置自动编辑器，也不写信任 store。
Pi 可以从工作台确认后调用 PATH 上的官方 `pi` 管理命令，使用 argument array、
继承终端并固定当前 COMMON_MEMORY_HOME，不拼 shell 命令。成功退出只证明该
Pi 命令结束，不证明扩展正在捕获或真实模型已读到记忆。

session-refresh 必须来自实际宿主实例＋thread，继续在会话内执行。
session-drain 的工作台动作前台启动原机器入口；Ctrl+C 停止该 consumer，持久
未完成工作留待恢复。flush/import/network-test 在进程内复用既有操作，取消信号
传给对应模型请求。保存配置不执行网络测试、不热更新／热撤销现存客户端。

## 关键解耦

- `src/cli/operations.ts`：共享状态快照、授权读取、项目注册／移除、retry；
  `main.ts` 和 TUI 都调用这些函数，没有各自一份 SQL／权限选择／锁实现。
- `tui-settings.ts`：配置表单、状态格式；保留可选 sessionCache、旧 proxy 字段缺省、
  未修改的密钥和 CA。保存前检查配置是否被外部编辑，防止长时间表单覆盖已观察到
  的新版本；这不是多个配置文件的原子事务或完整的并发锁协议。
- `tui-prompts.ts`：TTY、返回／取消、错误隔离、终端文本和分页呈现。
- `tui-integrations.ts`：宿主工作流和就绪说明；生成内容仍来自原 generator。
- `work-config.ts`：准备／渲染与写 bundle 分开，CLI 和 TUI 共用，预览没有文件写入。
- `interactive-process.ts`：有界的原生宿主／消费者命令交接，不调用 shell。
- import/flush 使用原函数；network-test 加可注入日志和取消信号，仍不打开 SQLite。

没有修改 Core、Writer 决策协议、scope/provenance 映射、MCP 或 Pi capture 代码。
配置保存仍由现有 validator 和 private file writer 完成。secret 和 JSON 是两个
独立私有文件，不承诺它们跨文件提交的原子性。

## 验证与剩余限制

测试入口：

- `tests/cli/tui.test.ts`：真实业务配置／文件＋脚本化 prompt 驱动导航，覆盖取消、
  错误、授权分离、导入/flush/probe/recovery 路由、配置保留、终端转义和 Pi 交接。
- `tests/cli/workbench-entries.test.ts`：真实子进程非 TTY/CLI、机器错误通道、
  scope 隔离、无正文 job/session 状态、bundle 冲突／symlink 和共享生成结果。
- `tests/cli/network-test.test.ts`：合成 probe 输出、取消信号和连接／监听器清理。
- 既有 import、MCP、Pi、Codex/Work、session-drain 测试继续覆盖下层真实路径。

完整 gate 使用 Node 24.x：`node scripts/verify.mjs`；构建后追加
`npm run test:consumer`。无需个人记忆、真实模型或生产集成设置。

本次结果（Node 24.20.0）：

- 完整 gate 通过：typecheck、63 个源文件边界检查、35 个测试文件／425 项测试、build。
- tarball consumer 通过：typed consumer、维护 prompt asset、Writer、Pi load、CLI startup。
- 构建产物的真实 Linux PTY 冒烟通过：Home→Overview→Memory、授权文档分页、
  终端 resize、逐层 Esc 返回和正常退出；确认未创建 SQLite、未改变 Markdown。
- `git diff --check` 通过。没有调用真实模型，也没有安装／修改用户生产宿主配置。
- 首次全量 gate 暴露了预览测试的分页断言错误，已修正；另一个既有网络测试依赖
  `.invalid` 必然 DNS 失败，但此环境实测解析成 `198.18.0.87`。测试改为受控
  `dns.lookup` 返回 ENOTFOUND，仍经过真实 NetworkClient 的错误处理；生产网络
  代码未因该测试改变。复验全部通过。现有 TLS-IP 弃用和 SOCKS5 实验性警告仍存在。

尚未覆盖：真实 Desktop UI 的信任、宿主配置合并后的端到端启用；本次 Linux
终端检查不证明 Windows/macOS 真机体验或 CI。宿主安装和存活状态不做猜测，
必须在宿主核验。不存在统一的一键暂停所有消费者／撤销已披露记忆的能力。
已损坏或不支持版本的配置仍 fail closed，需要先在文件中修复；没有静默重置或
迁移。高级参数仍是受校验 JSON 表单，不是每个参数独立控件。
