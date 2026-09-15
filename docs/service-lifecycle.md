# 独立 Core 生命周期（v0.4.3）

## 运行与授权

Pi、stdio MCP、Codex/Work Hook 和 CLI 是渠道。`src/service/daemon.ts` 是唯一生产维护进程：持有 Writer、持久队列、宿主 inbox 消费、配置刷新与恢复。渠道通过本机私有 Unix socket 请求 Core；不提供 HTTP，不增加检索/索引。读取 canonical Markdown 不依赖维护模型，read MCP 不打开 SQLite。

每个固定接入 profile 有独立凭据，服务端从 grant 文件确定身份和权限，不采用工具参数自报的 capability。Pi 的进程关联键不授予额外权限。边界是同一 OS 用户的私有服务，并不防御能读取该用户全部凭据的恶意本地程序。socket 使用固定短路径，目录 0700、socket 0600；单帧上限 64 MiB，超限拒绝而非截断。

接受回执只在队列和请求摘要事务落盘后返回。请求身份、操作与摘要绑定；响应丢失报告 `DELIVERY_UNCERTAIN`，同次投递使用相同 ID 重试；不同正文冲突。新的显式重试、刷新或取消使用新的操作 ID。回执不等于已记住，最终应核验 Markdown 与任务结果。Hook 回放保存快照引用，并重新核验当前授权，不能注入已撤权的缓存内容。

## 监管、交接与取消

- Linux：systemd 用户服务。
- macOS：用户 LaunchAgent；不承诺跨用户注销运行，不自动提权。
- WSL：Windows 用户计划任务持有前台 `wsl.exe`。登录触发和每分钟恢复触发配合 `IgnoreNew`，不产生第二个 Core；单独 `RestartOnFailure` 在实测窗口内不足以恢复。没有任务总运行期限。
- Core 以独立 SQLite 锁排他占有 dataRoot。进程崩溃释放内核锁；监管器恢复，不依赖下一条宿主消息。

`common-memory service start|stop|status|remove` 管理当前 home 的服务。stop/remove 先持久禁接收及唤醒，再请求 `SERVICE_HANDOFF`，等待 Core 释放所有权后停止自己的原生服务，不杀 Agent 宿主。计划交接保留任务身份、恢复预算和累计轮次；用户取消是另一项持久操作，阻止迟到结果提交，也不会被配置刷新自动复活。

完整 settled 交互立即入批；未确认的尾部仍是 buffered/incomplete，退出或 flush 不伪造完整性。初次尝试之外最多五次自动恢复，由 SDK/Agent/队列共享持久预算；保留轮次限制、单次网络无进展检测和显式取消，没有整项维护总期限。配置和凭据在下一任务开始前刷新，执行中的任务保持快照；保存设置不重启 Core。

## 旧接入迁移与升级

1. 保留整个 dataRoot，尤其不能删除 SQLite 来“重建”。
2. 安装完整新包后使用 **Upgrade / Repair Integrations** 激活新 Core；Core 通过稳定 home launcher 选择当前目标。服务模式生成的 MCP/Hook 入口使用稳定 shell launcher，Pi wrapper 在重载时读取目标 manifest，而不是钉住旧包路径。
3. 协议 1→2 在 repository lock → DB 写事务中备份、替换精确归属的协议 trigger，并更新旧运行任务的 token/generation。旧 Writer 的 SELECT 租约检查和后续写入均失效；冲突 trigger 或并发变化会阻止迁移。Core 接受新请求前恢复 canonical 回执。
4. **磁盘更新不代表 Pi 已加载新代码。** 初次从嵌入式版本迁移后需 `/reload` 或重启相关宿主/MCP；服务协议兼容的已加载渠道可以重连。
5. Agent Integration 扫描真实注册，即使 ownership 为空；展示路径及结构差异，明确确认后 compare-before-write 事务迁移。混合 Hook 只移除属于 Common Memory 的 handler，保留其他配置。模糊引用阻断，不猜测删除。

卸载默认保留配置、凭据与记忆。损坏/缺失 config 但 ownership 完整时提供仅移程序及精确归属接入的受限路径。明确记录为 service-channel 的活跃宿主不阻止卸载；仍无法证明安全的旧/unknown 嵌入式实例会阻断并要求重载/处理，不通过布尔声明绕过，也不强杀宿主。任意损坏状态下“必定可卸载”不在保证范围内。

## 验证与限制

- `node scripts/verify.mjs`：类型、边界、全套测试与构建。
- `npm run test:consumer`：安装后的导出、Pi、MCP、事务和受限自卸载。
- build 后 `CM_RUN_NATIVE_SERVICE_TESTS=1 npx vitest run tests/service/native-lifecycle.test.ts`：临时原生服务，强杀自动恢复，同 taskId、一个 observation、一份实际 canonical 回执与 Markdown，以及移除后拒绝唤醒。
- `npm run test:wsl`：安装后的真实 WSL PTY、`wsl.exe` read/init MCP、Windows 合成宿主、Unicode/复杂路径、冻结快照刷新与宿主退出后提交。

当前环境已通过 WSL 原生监管恢复与上述跨边界测试；未验证 macOS/Linux 原生服务管理器、完整 WSL 发行版关闭、注销、休眠、重启，以及真实 Desktop UI 的信任/加载交互。不会为测试而关闭用户正在使用的发行版。

设计依据：[WSL systemd](https://learn.microsoft.com/en-us/windows/wsl/systemd)（systemd 服务本身不保活发行版）、[Scheduled Task triggers](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasktrigger)、[RestartOnFailure](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-restartonfailure-settingstype-element)。官方能力说明不能替代真实进程验收。
