# V2 交付验证 — 2026-09-05

## 改动范围

- `src/v2/`：Markdown、可恢复文件事务、统一 SQLite、混合调度、协议、Writer、Project Registry、安全错误码和 repository lock。
- `src/pi-extension/`：durable delivery / stable entry 绑定、来源隔离、稳定边界和生命周期处理。
- `src/config/`、`src/cli/`、`src/index.ts`：V2 配置、注册/status/flush/retry、Write-only 公共面。
- `src/memory-manager/openai/`：复用 native fetch、超时/取消/有界响应，增加精确请求字节计算。
- 移除旧 Fact/Proposal/Review/Recall/FTS/Undo、旧测试/fixture/schema 和失效文档。移除 yaml、ajv-formats、直接 typebox peer；不新增运行时依赖。Pi peer 锁定 0.84.4。

## 新鲜执行证据

- `npm ci`：成功；审计 0 vulnerabilities。
- `npm run lint`：typecheck 与 27 个源文件边界检查通过。
- `npm test`：12 文件，101 测试通过。
- `npm run build`：通过。
- `npm run test:consumer`：真正生成/解压 tarball，验证 typed consumer、包内 Maintainer、Writer 空队列、Pi 加载、CLI 启动；不存在旧 Fact/Recall 打包产物。
- `npm run test:remote-contract`：4 文件，20 离线远程适配器协议测试通过；不是 live provider 调用。
- `node scripts/evaluate-v2.mjs`：30 合成轨迹，每 Turn / fixed-six / Hybrid 三策略均最终状态 30/30、Scope error 0、retry 0。调用次数 210 / 60 / 60。
- 重复三策略评测 10 次（900 个 trajectory-policy 执行），结果见 `v2-evaluation-repeat-results.json`。
- `git diff --check`：通过。

故障测试包括真实子进程在事务阶段强制退出、文件成功/DB回滚恢复、双进程同库竞争、过期旧 worker、人工编辑 CAS、暂存后修改、发布 marker 前 fencing、Project 注册撤销竞态、手工改名/删除后的遗忘/no-op、Section 来源继承隔离。

## 独立审查

- `code-reviewer` 独立 lane：APPROVE，最终增量复核包含注册重验、暂存后 CAS、snapshot journal.before、发布前 lease/取消校验；另复核银行卡扫描仅排除完整 UUID、中文邻接卡号和 UUID-shaped 凭据仍被保护；0 未解决问题，独立复跑 101 tests + lint 通过。
- `architect` 独立 lane：WATCH，无未解决架构 BLOCK。
- 合并审查结论：COMMENT（有已披露观察项，不宣称无风险 APPROVE）。

## 未验证与观察项

1. **真实模型语义质量未验证。** Scripted oracle 只证明协议/执行器与调度；Token 值 `tokensMeasured:false` 不是免费或真实用量。真实 provider 评测需显式 opt-in，未自动使用凭据或产生费用。
2. **Pi 原始输入溯源边界。** 公共 API 无端到端原始输入 token；更早执行的扩展必须属于可信宿主，README 说明扩展排序。自动化使用真实类型与源码事件契约、fake host 驱动；未进行真人交互的 live Pi/远程模型联调。
3. **长期规模。** 空队列不扫描历史回执；活跃恢复仍遍历永久回执，数据规模很大时需增量协调优化。
4. **人工 Markdown 改动。** 标题身份失效时，保守清理该文档短期 processed evidence 缓冲与旧关联，不删除当前 Markdown 或其他文档。此行为以同一 DB 或文件回执事务恢复。
5. 不迁移或自动清理任何旧用户 dataRoot；Forget 不等于删除 Pi transcript、介质安全擦除或永久禁止未来重述。

## 评测稳定性修复记录

最终复跑曾发现随机 UUID 数字段被旧 payment.card 规则误报，导致 scripted
评测间歇失败（10 次复跑中 7 次含失败）。已增加完整 UUID 识别，仅对银行卡
数字规则排除整个 UUID token，其余秘密规则仍检查原文；保留原卡号匹配规则，
避免中文/Markdown 邻接的漏检。新增 12 项安全回归覆盖 UUID、中文卡号、
空格/连字符卡号、UUID 与真实卡号混合、UUID-shaped API key。最终重复结果单独保存，
不将早期偶然通过当作稳定性证据。
