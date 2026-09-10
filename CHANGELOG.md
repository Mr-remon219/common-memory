# Changelog

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
