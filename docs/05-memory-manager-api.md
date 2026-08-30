# MemoryManager API

根入口导出 `MemoryManager`、`MemoryModelPort`、`ObservationSourcePort`、`RemoteDisclosurePolicy`、`LocalUserMemoryControl`、run DTO、scheduler、治理日志和 undo DTO。原始 Authority 构造器、RepositoryLayout、YAML transaction 与 raw provider envelope 不公开。调用方通过 `createLocalUserMemoryControl(core, {sessionId})` 显式取得绑定 Core 的本地人工治理 facade。

`extract({observations, signal, deadlineMs})` 处理正常完成且含新用户内容的 turn；`consolidate` 处理后台候选。ObservationSourcePort 根据 reference 重取最小正文并逐字校验 digest。

Outcome：`committed | idempotent | no_op | refused | blocked | deferred | failed | cancelled`。Refusal 仅返回 category、HMAC fingerprint 和数值 usage。授权、安全、大小失败发生在 fetch 前；MemoryManager 与 OpenAI adapter 都执行同一 disclosure preflight，因此直接调用公开 adapter 也不能绕过外发门。

Governance：`listGovernance` 游标绑定 store revision；`getGovernanceBatch` 按 batch 查询。人工 propose/review 与 Undo 通过 `LocalUserMemoryControl`；`previewUndo` 后携带同一 preview 调用 facade 的 `applyUndo`。
