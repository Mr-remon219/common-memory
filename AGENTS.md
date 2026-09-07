# Common Memory development

Current implementation and boundaries are described in `README.md` and enforced by `scripts/check-boundaries.mjs`. `docs/note.md` contains future ideas; distinguish them from current behavior. Writer benchmark work lives in the separate `../memory-benchmark` repository.

- Preserve the current authority boundary: canonical Markdown under `<dataRoot>/memory/` is the fact source, runtime SQLite is the durable queue/lease/source-link store (not a rebuildable index), remote models return `memory_maintenance_v2` decisions, and Core validates and commits writes. Pi integration is an Extension that captures user turns and injects authorized memory into the system prompt on `before_agent_start`. MCP is stdio only, with launch-fixed capability profiles (`relay`, `init`, `read`); `read` processes never open the runtime database. Other agents' summaries enter only as `agent_import` observations via `memory_init`; they are attributed, never treated as user statements, and never sole evidence for forget. There is no retrieval, index, HTTP transport or Recall write authority; do not add them because older notes mention them.
- User questions marked “只回答/不修改” need an explanation grounded in current code, not implementation or a file-diff requirement. For “讲简单些”, explain the input, the responsible component, and its output before implementation details.
- Before continuing a past task, verify its checkout, current revision, test paths, and the latest user correction. Historical docs-ignore rules, branch names, or model settings are not permanent defaults.
- If delegated work is explicitly requested, verify the child's tools and evidence needs before dispatch. Keep the parent available for questions; prefer event-driven completion. A child waiting for evidence or a decision is different from a hung process. Reuse valid completed results and fix the specific missing capability or input.

## Verification

Node 24.x and installed dependencies are required. Run `node scripts/verify.mjs` (or `npm run verify`) for the full gate: typecheck once, boundary checks, full tests once, then build. CI and prepublish use the same entry.

Use `test:fixtures`, `test:recovery`, or `test:remote-contract` for a focused change; those tests are included in the full suite and do not need to run again beside it. For package export/consumer changes, also run `npm run test:consumer` after the build. Live model calls and personal data are not needed for the fake-provider contract tests.

Keep a failed check's exact output and resolve its demonstrated cause. Stop adding review or rerunning passing tests once the requested behavior and relevant acceptance conditions are verified. Linux evidence does not prove Windows CI passed; report platform gaps separately.
