# Changelog

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
