# Changelog

## 0.4.3 — 2026-09-15

- Move production maintenance into an independently supervised Core service. Pi, stdio MCP, Codex/Work hooks and CLI use private Unix IPC with server-owned fixed-profile grants and durable request/digest replay; channel exit does not cancel accepted tasks.
- Add systemd user, macOS LaunchAgent and WSL Windows Scheduled Task management, stable channel launchers, explicit cancellation and budget-preserving service handoff. WSL uses foreground wsl.exe plus a repeating recovery trigger; native crash recovery verifies one task and one canonical receipt.
- Fence protocol-1 writers' leases and mutations during transactional protocol-2 takeover without discarding task identity, source links or recovery counters. Repair paused-only queues and known repairable legacy failures without reviving cancellation or quarantine.
- Scan legacy registrations even without ownership records; confirm structural migration and preserve unrelated hooks/configuration. Disable service admission before safe uninstall; retain configuration, credentials and memory by default, including a restricted unreadable-config path.
- Keep in-flight configuration snapshots while refreshing settings for later tasks. Fix repeated explicit retry/refresh IDs, truthful cancellation results, revoked snapshot replay authorization and native host identity validation.
- Validation: 885 passing tests, package consumers, installed real WSL PTY/read/init MCP and Windows-to-WSL synthetic host bridge, plus separately enabled native Core crash recovery. Native macOS/Linux supervisor behavior, full WSL logout/reboot and real Desktop UI trust flows remain unverified.
- Upgrade: preserve the complete dataRoot, activate Core through Upgrade / Repair Integrations, then reload legacy Pi/MCP/host integrations. Unknown embedded hosts can still safely block uninstall; no host is forcibly terminated. See docs/service-lifecycle.md.

## 0.4.2 — 2026-09-14

- Completed, delivered interactions queue immediately instead of waiting for ten turns; open interactions remain buffered and source/target ordering remains enforced.
- Saved model, credential, network and scheduler settings refresh between tasks. In-flight tasks retain their snapshot; maintenance no longer has a whole-task 60-second deadline.
- Core owns a durable budget of five automatic recoveries beyond the initial attempt. SDK retries are disabled; same-Agent repairs, queue recovery and restart recovery share counters. Explicit retry preserves job identity and receipts.
- Protocol-1 migration creates a durable data backup, rejects active legacy writers, and fences mutations on all durable tables. Exact-source forget tombstones and ordinary correction watermarks prevent stale replays; manual Markdown edits do not imply semantic forget.
- Add TUI Upgrade / Repair Integrations, loaded-instance evidence, separate uninstall retention choices, paused-state visibility and durable progress counters.
- Add bounded built-in maintenance/recovery skills and sanitized schema feedback. Fix credential/redaction and numeric-identifier scanner cases without allowing the reviewed credential-prefix/card-masking bypasses.
- Validation: 845 tests, isolated package consumers, real WSL bridge/TUI, and synthetic real-model remember/correct/forget/replay checks. Full deidentified historical-corpus replay and existing real-client reload/lifecycle acceptance remain incomplete; see `docs/reliability-refactor.md`.
- Upgrade: stop old writers normally, preserve the full data/configuration backup, repair managed integrations and reload hosts. Do not delete SQLite, downgrade its protocol marker or mix old/new writers.

## 0.4.1 — 2026-09-13

- Isolate malformed Codex/Work activations without blocking healthy inboxes; retain original inputs/cursors and stable explicit recovery IDs. Bound the complete drain, reject stale failure records after concurrent consumption, and page all recovery entries.
- Report buffered turns, queued work, host inboxes and isolation separately; ordinary flush does not seal sub-ten-turn batches or claim global completion prematurely.
- Add reachable project registration/removal, read/write/provenance authorization and managed read MCP workspace selection. Bind both path and project ID, explicitly confirm all shared-config owners, and preserve global-only init scope and existing permissions.
- Keep first-run model discovery failures in an unsaved URL/key/network draft; support proxy/CA retries and same-provider manual models. Atomically save successful configuration and credentials; retain compatible private keys/thinking settings.
- Separate native TUI/Pi edits from automatic learning. Persist bounded modified/already-satisfied/clarification-required/refused results with existing receipts, and require current-request evidence for every edit write. MCP profiles/tools remain compatible; no model-supplied edit authority.
- Measure complete UTF-8 source projections consistently across ingress paths; retain the stricter deprecated candidate cap, batch/payload caps and no-truncation behavior. Clarify that on-demand reads replace older snapshots only for the same scope, including deletions.
- Preserve the existing Service → Memory Agent → Core, Bundle, lease/CAS and recovery architecture. No polling, push synchronization or historical edit-priority arbitration; late old evidence may still override newer intent if the model proposes it.
- Stop all old writers and back up the complete dataRoot before upgrading. Local checks do not establish registry or real Desktop UI acceptance; verify the exact published artifact and release CI separately.

## 0.4.0 — 2026-09-13

- Replace the production Model Layer with an independent Pi Agent Core/pi-ai 0.85.1 Memory Agent Runtime. Core retains disclosure, provenance, admission, import guards, canonical writes, leases, receipts and recovery; Runtime owns System, providers, tools and multi-turn decisions.
- Persist reference-backed structural Ingest Bundles for every observation and assistant/tool context. Init and Markdown remain separate attributed entry points. Paginated authorized tools disclose complete source descriptors; Core requires complete current-source and edited-target reads before consuming a proposal. Backfill preserves source identities, NUL/NULL and purge behavior without copying plaintext.
- Default input/output limits to Unlimited while honoring explicit existing caps. Use reliable model capabilities or Unknown/custom; preserve safe context notes, cancellation and bounded attempts. These limits do not guarantee arbitrary-size completion or measured real-model quality/token cost.
- Add Pi's `/memory` management page for authorized browsing, adjustment, confirmed imports and processing status while retaining `/memory-refresh` and `/memory-flush`. Preserve the CLI TUI setup flow and external MCP/host contracts.
- Breaking JS API: replace `MemoryModelPort` and old model adapters with `MemoryAgentRuntime` and `Writer({agent, ...})`; `createConfiguredWriter` remains available. Keep standalone `chunkMarkdown` exports deprecated and isolated from production ingest.
- Validate runtime prompt digests before consumption, sanitize receipt usage, and stop context exhaustion without rejecting Pi's transform callback. Consolidate fixtures and test real Pi tool loops, source coverage, durable context migration and installed-package behavior.
- Before upgrading, stop all old writers and back up the complete dataRoot, including SQLite and recovery metadata. Do not run old and new versions against the same database; upgrades do not modify personal client registrations automatically.

## 0.3.9 — 2026-09-13

- Use only the TUI-configured private `.env` for model credentials across CLI, MCP, Pi and detached Writers, including legacy configs. Remove host-environment key precedence, external-key selection and the SDK `loadLocalEnv` export; never export private settings into the host environment. Existing installations relying on shell keys must configure their key in the TUI and restart clients.
- Stop durable automatic retries for permanent provider authentication, configuration and protocol errors; retain the failed input for explicit retry. Preserve bounded backoff for transient network failures, Core decision retries and resumable host cancellation.
- Cover private-key selection/rotation, missing-key refusal, one-attempt 401 failure, explicit import recovery and HTTP 200 mid-body disconnect recovery with fake-provider regressions. Provider smoke uses private credentials and removes its temporary credential files before keyless read verification.

## 0.3.8 — 2026-09-12

- Add explicit, default-off AI understanding import selection to the TUI for local Codex / Desktop Work. Register a separate init-only MCP with host approval; commit any newly confirmed `agent_observation` disclosure permission atomically with installation. Preserve read-only defaults, provenance and Core write authority.
- Actually start the managed read MCP and check its tool list after applying integrations, with bounded failure reporting. Show config paths, registered capabilities, reload/profile guidance and the ordinary Chat/web limitation; never equate file ownership with a live host connection. Probes do not read memories or start Writer/init processes.
- Keep macOS Desktop's default configuration root separate from a terminal-only `CODEX_HOME`; safely migrate old managed resources when reapplied.
- Check independent Codex profile files before complete uninstall, and preflight unmanaged references before deleting registrations so blocked retries retain custom-root ownership. Preserve unrelated files, shared owners and memory data.
- Add installation/consent/rollback/probe/removal regressions and installed-package discovery checks for both read and init MCP. Upgrade the npm package, then reapply Agent Integration; existing read-only installs do not automatically acquire import authority.

## 0.3.7 — 2026-09-12

- Fix ChatGPT Work and Codex hook configuration warnings: emit `additionalContextLimit = 0` only for SessionStart, UserPromptSubmit and PostToolUse, never Stop, Interrupt or SessionEnd.
- Share event-aware command configuration between automatic JSON installation and manual TOML bundles on POSIX and Windows-through-WSL. Keep capture, refresh, timeouts and host trust unchanged.
- Verify transactional upgrades from v0.3.6 shared hooks, preserving unrelated hooks, remaining owners and safe uninstall. After upgrading, reapply the existing Agent Integration selection; manual bundles must be regenerated and reviewed.
- Add regressions for both clients, native bridge configuration and terminal events with pending refresh context.

## 0.3.6 — 2026-09-12

- Default new configurations to ordinary OS networking: ignore application proxy environment variables while allowing system routing, VPNs and Clash TUN to handle traffic. Preserve explicitly configured and legacy network modes.
- Support IPv4/IPv6 CIDR exclusions in opt-in proxy modes, matching IP-literal endpoints only; malformed settings still fail closed without silent direct fallback.
- Keep Pi's authenticated local capture durable when maintenance network initialization fails. Defer transport construction and report bounded, redacted, actionable diagnostics instead of repeated generic capture warnings.
- Accept numeric Codex host versions >=0.153.4 without an upper bound. Validate known rollout structures from the 0.153.4/0.154.0 contracts, including retained context, while preserving candidate matching and rejecting unknown structures.
- Install automatic ChatGPT Desktop Work capture and explicit refresh on POSIX and Windows-through-WSL. Share a single stable Codex-host capture pipeline when Codex and Work share a configuration root; do not guess frontend identity or install new import capabilities.
- Reconcile retained managed integrations so existing read-only installations gain capture when reapplied. Preserve unrelated configuration, shared ownership, host trust requirements and safe removal.
- Add test-first network, real Pi SDK, newer-rollout, installation-upgrade and shared-owner regressions; extend the real WSL smoke to exercise automatically installed capture resources.

## 0.3.5 — 2026-09-12

- Remove Pi's exact-version discovery gate and use a `*` host peer dependency. Installed Pi versions are selectable without launching the agent; 0.84.4 remains an event-contract validation baseline, not a version requirement or a claim of universal runtime verification.
- Fix WSL discovery of Windows ChatGPT Desktop when its display name is ChatGPT but its Appx package remains `OpenAI.Codex`. Use a read-only Start menu fallback without treating a Codex-only installation as ChatGPT.
- Share client presence and installation discovery. Check both macOS Applications directories and reject same-named ordinary files.
- Add test-first regressions for Pi admission, macOS discovery, package metadata and the actual PowerShell discovery script. Preserve Codex's existing capture-format restrictions and Desktop read-only scope.

## 0.3.4 — 2026-09-12

- Split verification by deployment: Linux and macOS retain full Node 22.19 / 24 gates and isolated npm installs; native Windows runs a small PowerShell bridge suite instead of the entire Core suite.
- Exercise generated PowerShell in a real native process: fixed WSL arguments, Unicode stdin, path conversion, encoded hook commands, capability isolation and failure exit codes.
- Fix PowerShell 5.1 native argument forwarding for quoted Linux paths and Windows paths with spaces and trailing backslashes. Existing Windows hook bundles must be regenerated to receive this fix.
- Add an explicit real-WSL installed-package smoke for first-run/repeated TUI navigation, read-only MCP through wsl.exe, and synthetic native host hooks/refresh/Writer drain. Missing WSL interop fails instead of silently skipping.
- Remove duplicated tag Core runs and migrate the environment-dependent WSL unit test into the dedicated smoke. Critical Core durability and recovery tests remain in the POSIX full suite.

## 0.3.3 — 2026-09-12

- Reap CLI test children and wait for their stdio to close before deleting temporary
  databases, including after a test timeout. This prevents Windows SQLite EBUSY cleanup failures.
- Give import and crash-recovery subprocess tests explicit time budgets and preserve
  timeout, signal, stdout and stderr diagnostics instead of reporting only a null exit code.
- Limit Windows test workers to two to reduce competing durable filesystem operations.
  Retain the full test suite, crash checkpoints and cancellation assertions.
- Add real subprocess regressions for database lock release, cancellation, output
  draining and timeouts. Audit every run for the release SHA, including tag-triggered CI.
- Retain the Node 22.19+ (22.x) / Node 24+ runtime support and TUI/database fixes from 0.3.2.

## 0.3.2 — 2026-09-12

- Flush queued startup warnings before rendering the interactive CLI, preventing
  SQLite warnings from displacing the cursor and leaving duplicate menu rows on
  arrow-key navigation. Keep warnings visible and drain them before every prompt,
  including when a database is first opened between menus.
- Add a real-renderer subprocess regression for startup warnings, repeated arrow
  keys, Esc cancellation and terminal raw-mode restoration.
- Load SQLite only for actual database operations; read-only memory, configuration
  and help paths do not load SQLite. Keep all database opens behind one entry.
- Close host and Pi/MCP writer resources on initialization failures, and reject
  asynchronous transaction/lock results before committing.
- Support Node 22.19+ on the 22.x line and Node 24+. Align development types,
  verification scripts and CI/installed-package matrices with the minimum runtime.
- Read stored conversation/snapshot bodies as UTF-8 bytes to avoid Node 22 SQLite
  truncation at embedded NUL; preserve existing TEXT storage, deduplication and attribution.
  Test legacy host proxy routing both with Node's flag and an explicit host dispatcher.

## 0.3.1 — 2026-09-12

### Unified interactive management

- Use `common-memory` for first-time setup and all everyday management. Initialized
  launches open Agent Integration, Memory Control, and Model & Configuration.
- Share one Agent multiselect between setup and management. Apply installation and
  removal differences in a single recoverable transaction, preserve shared MCP
  resources, and reject stale ownership or damaged retained integrations.
- Configure Provider → editable Base URL → hidden API Key → Model during setup or
  later model changes. Display complete configuration, key presence, network route,
  storage paths and installation health without revealing private credentials.
- Search authorized canonical Markdown by literal keyword, browse complete memory,
  and submit natural-language personal or authorized project adjustments through the
  existing Writer/Core. Manage durable pending and failed requests inside the TUI.
- Keep network configuration, connection testing and complete uninstall accessible
  from the workbench. Preserve scriptable commands and existing compatibility shortcuts.
- Cover unified navigation, scope authorization, model configuration and transactional
  Agent changes with offline tests, packaged consumer checks and a Linux PTY journey.

### Boundaries

- No changes to memory authority, queue schema, maintenance protocol, provenance
  permissions or host trust. Local text matching adds no retrieval index or model call.
- Existing V2 configurations remain compatible. ChatGPT integration is for supported
  local Work/Desktop hosts; ordinary Chat and automatic Desktop capture remain outside
  this integration. Real host trust and model semantics require separate validation.

## 0.3.0 — 2026-09-11

### Minimal setup and management

- Reduce management to Overview, View Memory and Modify Memory, accessible through
  interactive `common-memory show` and already-configured `common-memory`.
- Submit natural-language personal-memory changes as user expressions through the
  existing configured Writer/Core; distinguish processed, pending, failed and cancelled.
- Preserve non-TTY `show` output and add explicit `show --plain`; keep automation and
  machine protocol commands separate from the management menu.
- Add Provider → API Key → live single-select model setup with built-in URLs. Custom
  asks URL/Key/Model only; startup and runtime never discover models. Unsupported Go
  protocols are excluded rather than sent to a guessed endpoint.
- Commit model configuration and private credentials recoverably; explicit setup keys
  are not overridden by inherited provider keys. Preserve old configuration behavior.
- Automatically discover and install owned Pi/Codex/Desktop integration files, with
  conflict protection, shared ownership and crash recovery. Pi requires 0.84.4;
  unsupported Codex capture versions and Desktop receive read-only MCP. Hook trust
  remains the host's responsibility, not an installation success claim.
- Display paths, data size, Provider/Model and verified installation-file presence,
  without opening Memory SQLite or claiming a running daemon.
- Add integration removal and exact-global-npm self-uninstall; Memory Data has separate
  default-preserve confirmation. Retain the entire durable dataRoot by default and
  reject unsafe deletion paths and unmanaged legacy references.
- Verify packaged automatic integration loading/removal and actual self-uninstall in
  an isolated global prefix; real desktop trust and provider semantics remain separate.

### Test quality

- Replace duplicate single-document recovery checks with multi-document subprocess
  interruption tests and a Writer files-before-SQLite crash/restart/forget journey.
- Verify session completion through dead-letter, explicit retry and restart, keeping
  incomplete turns incomplete even after their observations are processed.
- Test atomic multi-part import rollback and all-or-nothing rejection of mixed valid
  and unauthorized import decisions, without losing queued source material.
- Remove scripted semantic-answer fixtures and fixture-count checks; keep focused
  ablation report contracts and reduce redundant CLI startups. The full gate retains
  all safety boundaries and passes 508 tests; real-model quality remains independent.
- Make installation/setup unit fixtures independent of pre-existing build artifacts
  and bound scripted prompt retries, so clean-checkout CI fails promptly on regressions.

### Boundaries

- No change to canonical Markdown authority, durable queue schema, maintenance
  protocol, independent provenance permissions, or host approval/trust requirements.
- Existing V2 configuration remains compatible. Unmanaged legacy integrations are
  not silently taken over; uninstall preserves the complete Memory Data by default.
- Linux offline and package tests do not establish real Desktop UI, Windows/macOS
  host integration or provider semantic correctness.

## 0.2.1 — 2026-09-10

### Usability

- Replace module-oriented TUI navigation with a Chinese task menu: read memory,
  import Markdown, connect assistants, manage permissions, and recover work.
- Shorten first-time setup and offer optional connection, permission and test steps
  after saving. Remember the last home action and keep cancellation local.
- Rotate API keys independently of model setup. Replace advanced JSON editing with
  validated, single-setting menus and numeric inputs that preserve unrelated values.
- Offer an explicit permission flow before Markdown import; retain source attribution
  and distinguish queued material from processed or retained memory.
- Make Codex/Work technical previews optional, show an export summary before writing,
  and provide installation steps without claiming the assistant is already connected.
- Use readable empty states, progress and session summaries; retain raw job diagnostics
  for troubleshooting. Fix false configuration-conflict detection from key ordering.

### Boundaries

- No storage schema, model protocol, host trust or memory authorization changes.
- Generated bundles still require activation in the actual assistant. No automatic
  permission grant, data migration, or real-model/desktop validation is added.

## 0.2.0 — 2026-09-10

Initial public v0.2 release under the MIT license. Requires Node 24.x; Linux, macOS
and WSL use `npm install -g common-memory-core@0.2.0`.

### Included

- User-owned canonical Markdown with a durable SQLite queue, source links, leases,
  recoverable commits and controlled diagnostics.
- Local configuration/workbench, explicit network/proxy settings, project and
  disclosure permissions, Markdown import, retry, flush and session recovery.
- Launch-fixed stdio MCP relay, attributed Init and keyless read-only capabilities.
- Pi 0.84.4 session capture and authorized memory injection; Codex 0.153.4 / Work
  session adapters, reviewable integration bundles and explicit memory refresh.

### Release-readiness fixes

- Preserve API-key bytes when writing dotenv credentials and replace duplicate
  `export KEY=...` assignments during rotation; fail before writing values that cannot
  roundtrip safely.
- Build before packing, check explicit publishing rights/metadata before publishing,
  and include documentation and security guidance in the tarball.
- Replace symlink-based consumer smoke with an isolated production npm installation,
  typed exports, durable Writer/readback, Pi module load, CLI and read-only MCP checks.
- Document initial installation, support limits, release steps, complete backups,
  upgrades and removal without deleting user memory; move the detailed guide to `docs/usage.md`.
- Add `common-memory --version`, macOS CI and post-release npm installation checks
  on Ubuntu/macOS, without adding registry write credentials to CI.

### Boundaries

- Requires Node 24.x. Windows users deploy the runtime in WSL.
- Pi remains a required exact-version peer dependency, including for CLI/MCP installs.
- Real Desktop UI trust flows and the full real-host event matrix are not established
  by automated Core or package-installation checks, including on macOS.
- No V1 migration, retrieval/index, HTTP MCP, multi-tenant service or guarantee of
  correct real-model semantic decisions is added.
