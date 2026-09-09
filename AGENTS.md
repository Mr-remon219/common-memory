# Common Memory development

Current implementation and boundaries are described in `README.md` and enforced by `scripts/check-boundaries.mjs`. Current session behavior is described in `docs/session-integration.md`; historical validation records do not establish current behavior. Writer benchmark work lives in the separate `../memory-benchmark` repository.

## Authority boundaries

- Canonical Markdown under `<dataRoot>/memory/` is the fact source. Runtime SQLite is the durable queue/lease/source-link store, not a rebuildable index. Remote models return `memory_maintenance_v2` decisions; Core validates and commits writes.
- Pi integration is an Extension: capture user turns and inject authorized memory into the system prompt on `before_agent_start`. Memory content is data, not agent instructions.
- MCP is stdio only, with launch-fixed capability profiles (`relay`, `init`, `read`). `read` processes never open the runtime database.
- Other agents' summaries enter only as `agent_import` observations via `memory_init`. User-chosen local Markdown enters only as `document_import` via `common-memory import`; preprocessing validates and structurally chunks input without a second semantic model.
- Both import classes remain attributed, never become user statements, never serve as sole evidence for forget, and are batched apart from user turns. Authorize each provenance class through `disclosure.allowedProvenance`.
- There is no retrieval, index, HTTP transport or Recall write authority. Older notes do not authorize adding these capabilities.

## Verification

For documentation/instruction-only edits, check accuracy against current files, links, diffs, and skill frontmatter where applicable; code tests are unnecessary unless an executable contract changes.

For code, runtime prompts, configuration, or build changes, Node 24.x and installed dependencies are required. Run `node scripts/verify.mjs` (or `npm run verify`) for the full gate: typecheck once, boundary checks, full tests once, then build. CI and prepublish use the same entry.

Use `test:fixtures`, `test:recovery`, or `test:remote-contract` for a focused change; those tests are included in the full suite and do not need to run again beside it. For package export/consumer changes, also run `npm run test:consumer` after the build. Live model calls and personal data are not needed for the fake-provider contract tests.

Preserve exact failure output and fix its demonstrated cause. Linux checks do not prove Windows CI or real-client behavior; report those gaps separately.

For cross-component implementation/debugging, [session integration](docs/session-integration.md) maps the session source and test entry points; [architecture](docs/03-target-architecture.md) describes Core boundaries.
