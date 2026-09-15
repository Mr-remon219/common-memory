# 独立 Core 验证记录（2026-09-15）

下列实现阶段检查在发布提交之前完成，当时包声明版本仍为 0.4.2；不能据此判断已加载代码。

v0.4.3 发布准备：版本升级后的 `npm run test:wsl` 再次通过（`/tmp/common-memory-v0.4.3-wsl.log`），生产依赖审计为 0 vulnerabilities，发布元数据及 tarball 清单已检查。正式提交、CI 与 npm 产物以 GitHub v0.4.3 Release 和对应 Actions 记录为准。

- 基线提交：`7b2f6bfecdef8667b69f33d7e9bab2cf3887050b`。
- 验证源指纹：`3dbfc12fa29424ceaf8396818e83aedf1ba826efc4532b4e8821ee36cc3005a4`。范围为 Git tracked/untracked 非忽略的 src、tests、scripts、package.json、package-lock.json、tsconfig.json、vitest.config.ts；按路径排序，将路径加 NUL 和文件 SHA256 二进制摘要依次计算 SHA256。
- 环境：Node 22.23.1，WSL 2.7.11.0 / Ubuntu，Windows 10.0.26200.9168，PowerShell 5.1。

| 检查 | 结果 | 原始记录 |
| --- | --- | --- |
| `node scripts/verify.mjs` | 类型、108 文件边界、885 tests passed / 1 skipped、build 通过 | `/tmp/common-memory-final-verify.log` |
| `npm run test:consumer` | 安装后的类型导出、Pi、MCP、一次提交及重启恢复、受限自卸载通过 | `/tmp/common-memory-final-consumer.log` |
| `CM_RUN_NATIVE_SERVICE_TESTS=1 npx vitest run tests/service/native-lifecycle.test.ts` | WSL Scheduled Task 强杀恢复、原任务、一份实际 Markdown 回执、移除后禁唤醒通过 | `/tmp/common-memory-integrated-native.log` |
| `npm run test:wsl`（最新 build 后） | 实际安装包的 PTY、read/init MCP、Windows→WSL 合成宿主、复杂路径、刷新、宿主退出后 Core 提交通过 | `/tmp/common-memory-final-wsl-retry.log` |
| 稳定渠道入口 | MCP/Hook 使用稳定 launcher；Pi wrapper 不变时随目标 manifest 切换实现 | `tests/service/stable-entry.test.ts`，包含于最终全量测试 |
| `git diff --check` | 通过；无 staged 文件 | 本会话工具输出 |

保留了失败证据并修正原因：WSL 原始参数引用、仅 RestartOnFailure 未恢复、重复移除退出码、原生 Hook 实例包含冒号的 grant 校验、旧桥接 smoke 未安装独立服务。最终 WSL smoke 明确安装并清理自己唯一命名的临时服务。收尾另精确清理了早期失败 setup 测试遗留的两个临时计划任务，核对了 task 描述、完整启动参数及临时配置归属；未移除真实接入或用户记忆。

消费测试早于最后的稳定入口增量；其导出/事务覆盖未改变。之后的最新安装包 WSL 验收与最终稳定入口测试覆盖了新增入口及 native 路径。原生强杀测试后未改变 daemon、manager、Writer 或恢复实现；后续 Hook grant 校验由最终 WSL smoke 覆盖。

未验证：macOS/Linux 原生 manager、完整 WSL 关闭/注销/休眠/重启、真实 Desktop UI 信任交互。旧/unknown 嵌入式宿主无法证明安全时，卸载保守阻断而非杀进程。详见 [运行和迁移边界](service-lifecycle.md)。
