# Reliability refactor — evidence and implementation record

## Baseline (2026-09-14)

Source: `3f5862a5932876cc62dd625e7dfaef24ba4af05d`, package 0.4.1, clean `main`.
Node 22.23.1 on Ubuntu WSL2. Installed dependencies: pi-agent-core/pi-ai 0.85.1,
local coding-agent 0.84.4, OpenAI SDK 6.40.0, undici 8.10.2.
`node scripts/verify.mjs`: 61 test files / 800 tests, typecheck, boundaries and build passed.

### Observed locally (not inferred from old reports)

- Global 0.4.1 and repository dist matched for CLI, configured runtime, Provider,
  Writer and Pi extension. Four read/init MCP processes used that global CLI and
  the same Common Memory home. Disk equality cannot establish loaded code identity.
- The installation ownership record had no targets/resources, while those MCP
  processes remained alive. No Common Memory package was registered in Pi settings.
  Windows Codex configuration retained comments naming a nonexistent old test
  installation; comments are not executable registrations.
- Durable queue metadata contained authentication/network/timeout/truncation and
  sensitive-scan failures. 24 historical `done` jobs had 14 receipts. Retired retries
  are not successful commits. Historical failures are not attributed to current code.
- Personal source bodies and credentials were not printed or copied into this report.

### Baseline source findings (before this refactor)

| Finding | Evidence | Consequence |
| --- | --- | --- |
| Config and credentials frozen for process lifetime | `src/config/runtime.ts` | Test connection and an existing Writer can use different saved settings |
| Fixed 60-second whole task deadline | `src/v2/writer.ts`, `memory-agent-runtime/provider.ts` | Healthy multi-tool maintenance can be interrupted |
| SDK retries plus queue attempts | Provider `maxRetries` default 2; RuntimeStore maxAttempts 5 | Retry counts multiply and reset across retired/recreated jobs |
| Ten settled interactions required | `src/v2/session.ts` | Complete small work waits for quantity rather than readiness |
| Legacy queue thresholds remain | `RuntimeStore.claim` | Even delivered non-session work can wait |
| First running/retry job globally blocks claims | `RuntimeStore.claim` | Backoff blocks independent scopes |
| Retrying retires old job as done | `RuntimeStore.retry` | No-receipt retirement resembles success and resets attempts |
| Tool-based source path already exists | `memory-task.ts`, `agent.ts` | Preserve it; improve feedback/efficiency instead of adding a second path |
| Many model termination causes collapse | `agent.ts` incomplete helper | Recovery loses actionable cause |
| Chat reasoning effort rejected | `options.ts` | Saved chat model controls cannot express a supported parameter |

## Design choices

1. **Task boundary rather than process restart for saved model settings.** Freeze a
   complete validated configuration and private credential/network snapshot for a
   task; subsequent tasks reload saved configuration. Invalid or changed data roots
   must fail closed rather than silently use a different store. Host memory snapshot
   refresh is independent and remains explicit/session-bound.
2. **No whole-task deadline.** Preserve cancellation and lease fencing. Network
   connection/headers and stream no-progress detection use renewable per-operation
   bounds, not a deadline shared by all model turns.
3. **One durable recovery budget.** Disable SDK automatic retries. Core owns at most
   five automatic recoveries after the initial attempt, across process restarts;
   model turns and tools are counted separately. Parameter/coverage/proposal mistakes
   should return safe structured feedback to the same agent context, not recreate
   observations. Credential/configuration failures pause pending external repair.
4. **Immediate complete work, conservative ordering.** A settled delivered turn is
   ready. Open/streaming turns are not. Preserve same-scope ordering and source
   provenance partitions; allow unrelated scopes past a retry delay.
5. **Reuse authorized read capabilities.** Skills have an explicit bounded catalog
   and loader tool in the independent Agent; no filesystem/shell or Coding Agent
   runtime is granted. Core validation is mandatory whether skills are loaded or not.
6. **Upgrade and removal are owned transactions.** Reconcile managed integration
   resources idempotently, report loaded instances separately from installed files,
   and fence incompatible writers before schema changes. Never delete SQLite as a
   repair strategy. Unmanaged resources and unsupported host reloads are reported,
   not silently adopted, killed, or declared synchronized.

## External evidence

- DeepSeek thinking/tool-call contract: https://api-docs.deepseek.com/guides/thinking_mode
  (accessed 2026-09-14). Chat `reasoning_effort` and `thinking` are distinct wire
  controls; reasoning content must be preserved through tool calls. Unlimited means
  this application omits a cap, not that the provider has no limits.
- Version-matched local Pi 0.85.1 validation source confirms that framework argument errors include the raw arguments. The Runtime replaces these errors with bounded schema hints rather than forwarding that prose.

## Implemented behavior (unreleased working tree)

- Saved configuration/private credentials/network and scheduler settings are reloaded under the installation lock before the next task. Current tasks retain their snapshot. A pending installation transaction, missing configuration or changed data root fails closed. A new model is never chosen automatically.
- Complete delivered interactions queue immediately; open interactions do not. Project-only writes can bypass unrelated backoff; shared global writes remain conservatively serialized, with whole-snapshot CAS at commit.
- Initial execution plus at most five automatic recoveries share durable counters. Authentication/configuration, cancellation and exhausted limits pause; unknown permanent failures stop. Manual retry preserves identity, counters and receipts. Task-local context/turn exhaustion does not declare the whole provider configuration unusable.
- Exact normalized forgotten-source digests prevent re-ingestion with a new identity. Ordinary update/correct decisions record target watermarks; older evidence cannot overwrite newer corrections. Manual Markdown edits invalidate stale cached links without inventing a semantic forget. This is exact-source protection, not semantic recognition of every paraphrase.
- Runtime protocol 1 backs up protocol-0 data before migration and fences INSERT/UPDATE/DELETE on every durable table. Backups include a consistent SQLite snapshot and copied canonical/data files; files and directories are synced before publication. Active legacy leases or concurrent writes refuse migration. Connection fencing is compatibility protection, not protection against a malicious local database owner.
- Built-in maintenance/recovery skills use discovery → selection → loading → use. They never grant Core authority. Same-Agent repairs preserve context; safe schema feedback exposes only known field paths, validation keywords and known property names, never values or arbitrary error prose.
- Queue status exposes automatic recoveries, model turns, tool calls, configuration fingerprint and receipt presence. A historical `done` row without a receipt is not represented as a verified commit. Receipt presence also does not mean a new fact was retained or remains present today.

## Upgrade, interruption and rollback

1. Arrange for old write-capable hosts/drains to stop normally. Do not kill processes from the repair page. Preserve an independent backup of the entire data root **and** the Common Memory configuration/private credentials/installation ownership files; the automatic protocol backup is data-only.
2. Update the package through the existing package workflow, then open **Upgrade / Repair Integrations** in the TUI. It reconciles owned resources transactionally, preserves unrelated configuration and refuses silent adoption of unmanaged registrations. Empty ownership is not permission to claim existing resources.
3. Reload/restart the relevant hosts. Disk version is not loaded version. Proven receipts include process identity; unregistered or unverifiable instances remain `unknown`. A live old lease or `UPGRADE_WRITER_ACTIVE` is a reason to investigate the owner and retry later, not delete SQLite or its leases.
4. Protocol backups live under `<dataRoot>/runtime/upgrade-backups/protocol-0-<uuid>/`; inspect `backup.json` and keep the whole directory. Failure before schema commit leaves the old protocol in place; an interrupted backup directory is not itself proof of a completed migration. Do not manually clear an outstanding installation transaction to bypass the configuration guard.
5. For rollback, first stop all relevant writers normally and separately preserve the **current** complete data/configuration state. Validate a complete pre-upgrade backup in a separate location with its matching code. Restoring that backup intentionally loses subsequent accepted work unless it is separately reconciled. Do not downgrade `user_version`, remove triggers, combine an old database with newer Markdown, or merge WAL files from different snapshots. There is no automatic reverse migration or lossless rollback claim.
6. TUI uninstall independently asks whether to retain configuration/credentials and Memory Data; both default to retention. Refusal caused by unmanaged live references requires resolving the actual registration, not deleting comments or killing a process. Programmatic legacy defaults differ; use explicit options. Repair/uninstall is not an invitation to reimport all history.

## Verification record — 2026-09-14

No commit, publication, live package replacement, personal configuration/data mutation or termination of existing hosts was performed. Consumer tests install only into isolated temporary prefixes.

| Check | Result / evidence |
| --- | --- |
| Baseline full gate | 61 files / 800 tests; `baseline-verify.log` |
| Final integrated full gate | 68 files / 845 tests; typecheck, boundaries and build passed; `final-verify.log` |
| Installed consumer | Typed exports, durable write/readback/restart, Pi entry load, keyless read MCP, integration reconciliation and isolated uninstall passed; `final-consumer.log` |
| Real WSL installed gate | PTY TUI, real wsl.exe read/init MCP, generated PowerShell hooks, synthetic native host identity, Unicode/path conversion, refresh and post-host-exit Core drain passed; `final-wsl.log`. First failure was a stale PTY arrow sequence after adding the repair menu; preserved in `wsl-first-failure.log`, then fixed in `tests/wsl/tui.py`. |
| Review regressions | Credential-prefix and neighboring-number counterexamples; all-table legacy fencing; pruned user-source aliases; correction ordering, tombstones and manual-edit separation; task-local exhaustion and bounded read-tool repair |
| Configuration wire contract | Actual Pi HTTP loop with fake provider verifies frozen current task and changed next-task URL/key/model/thinking/reasoning/output cap; not real-provider configuration-switch evidence |

Local logs are in `/tmp/common-memory-reliability/`; temporary artifacts are not a portable archival guarantee.

### Real model, isolated synthetic data

The saved `deepseek-flash`, Chat Completions, endpoint and private network route were used without changing the model, credentials or personal store. Max Output remained Unlimited; turn limit 64. Only synthetic facts were sent. Source/build digest over built JS and Markdown: `0b769d36c43b6407d0ce1a36fee1fc3643128c09091ee2d313839c592d754f16` (uncommitted package 0.4.1). Evidence: `live-report.json`, `live.log`, reproducible local harness `live.mjs`.

| Phase | Total | Ready → Agent | Agent | Commit | Model turns / tools / recoveries |
| --- | ---: | ---: | ---: | ---: | --- |
| Remember Rust + conditional weekend preference | 19.573 s | 7 ms | 19.561 s | 2 ms | 4 / 10 / 0 |
| Ordinary correction Rust → Go | 15.059 s | 2 ms | 15.052 s | 2 ms | 6 / 10 / 2 |
| Native edit: forget synthetic facts | 9.315 s | 2 ms | 9.309 s | 2 ms | 4 / 9 / 0 |

Canonical Markdown was checked after each phase: the weekend qualifier survived correction, Rust was replaced by Go, and deletion removed the synthetic facts. Three canonical receipts were verified. Replaying the original source under a new identity was quarantined without another model request. The maintenance skill was actually loaded. Provider-reported aggregate usage was 86,125 tokens across the three tasks, including cache tokens; this is not a billing estimate.

Earlier real calls **failed** and are retained as `live-report-first-failure.json` through `live-report-seventh-failure.json`. They exposed quoted-redaction false positives, destination/section/coverage confusion, insufficient schema feedback and unclassified read-handle errors. The final correction exercised two recoveries without replacing the job. These failures are part of the evidence, not excluded benchmark samples.

### Comparisons and limits

- Scheduling changed from waiting for ten completed interactions to immediate readiness. The measured millisecond figures above include only this synthetic harness, not a host-delivery latency benchmark.
- There is no matched old/new real-model performance experiment, statistical speedup claim or broad quality score. Per-interaction scheduling can increase request/token cost relative to larger batches.
- Full raw historical-corpus deidentification/replay remains **not performed**. Historical failure-class regressions and the synthetic conditional-fact sequence are not a substitute. A reviewed, safe-to-disclose historical corpus is still needed for that acceptance item.
- Actual user-host reload synchronization, real Codex/ChatGPT Desktop application lifecycle behavior and native Windows CI remain **unverified for this snapshot**. The real-WSL gate passed using installed package 0.4.1 and synthetic native hosts; it does not prove an existing Desktop application loaded this code. Before release, rerun required gates against the exact release commit/version, not just this uncommitted build.
- This is an implementation and evidence record, not a claim that all requested acceptance work or release validation is complete.
