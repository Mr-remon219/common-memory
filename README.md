# Common Memory V2

Write-only, durable memory maintenance for Pi. Markdown is the authority for current
long-term content; SQLite stores pending deliveries, observations, jobs, leases,
source links and recovery metadata. There is no Fact/Recall/Undo compatibility layer,
search index, temporary memory product, or resident background service.

## Setup

Requires Node.js 24. `npm ci && npm run build`, then `node dist/cli/main.js config`.
The local wizard writes `~/.common-memory/config.json` and a private `.env` file
(`COMMON_MEMORY_HOME` overrides this location). Configure an OpenAI-compatible
Responses endpoint with Structured Outputs. Keys are never stored in canonical memory.
V2 requires configuration `schemaVersion: 2`; old configuration/data is not migrated
or automatically deleted.

Register the built package as a Pi extension using the package's `pi.extensions`
entry. It records input origins, durably records actual user `message_end` deliveries,
then binds stable transcript entries after Pi appends them. Assistant failure does not
discard delivered evidence. Input alone is not evidence. Ambiguous, detectably transformed, or
extension-originated messages are quarantined rather than silently trusted. No
assistant/tool/system/thinking/compaction text is supplied as new evidence.

## Commands

```sh
common-memory config
common-memory status
common-memory flush
common-memory retry <dead-job-id>
common-memory project register /absolute/project/path "Display name"
common-memory project list
common-memory project remove <id>
```

Project IDs are generated locally. Registry matching uses real paths and the longest
ancestor, frozen at capture time. Registration alone grants no permission: separately
add `project:<id>` to `disclosure.allowedScopes` and `writableScopes` in config.
Removing a registration leaves its Markdown intact. `status` reports pending,
quarantined, dead jobs and unbound deliveries without printing raw conversations.
Pi also provides `/memory-flush`. Shutdown queues a flush and cancels in-flight work;
it does not wait for a remote model. Restart resumes durable work.

## Maintenance

Canonical files:

```text
<dataRoot>/memory/profile.md
<dataRoot>/memory/preferences.md
<dataRoot>/memory/projects/<id>.md
```

Models receive full user turns and current authorized documents, and choose retain,
forget, maintain or ignore using `memory_maintenance_v2`. Only put/remove Section
operations are accepted; confidence is not an admission threshold. Unmodified
Sections retain their bytes. The packaged `dist/v2/memory-maintainer.md` is trusted
instruction text; document and conversation content cannot override it.

Default triggers: 6 delivered turns, 16 KiB, 120-second idle debounce, 10-minute
oldest backlog, lifecycle flush, or explicit flush. Timers run only within the Pi
process and model work starts at stable boundaries. Empty queues do not call models.
Request limit is 128 KiB, document soft budget 8 KiB and hard cap 16 KiB. Full turns
are never truncated; oversized turns are quarantined. Limits are configurable in
`scheduler` and disclosure `maxTotalBytes` (Writer also exposes deadline/size options).

Commits use repository lock → runtime DB transaction, lease fencing, complete-read
CAS, and recoverable Markdown + permanent immutable receipt publication. No network
runs under these locks. File-success/DB-failure recovery consumes the original batch
without another model call; unexpected user edits fail closed. Receipts contain hashes
and references, not historical Markdown or raw model responses.

Processed observation bodies are pruned after 7 days; pending/quarantined bodies
are not silently consumed. Forget clears current state and related processed bodies,
not Pi transcripts or underlying storage media, and does not prohibit future explicit
re-expression from being remembered.

## Validation and limitations

```sh
npm run lint
npm test
npm run build
npm run test:consumer       # actually packs, extracts, imports and starts the package
npm run test:remote-contract
```

Tests use scripted model responses to prove protocol, capture, scheduling and commit
behavior; they are not evidence of real-model semantic quality. Real-provider evaluation
requires explicit credentials and budget and is not run automatically. Transformed
inputs are conservatively quarantined; assistant context is currently omitted rather
than disclosed without independent permission. No old user data directory is cleaned.

### Capture trust boundary

Pi does not expose an end-to-end original-input token. Common Memory validates the
input event it receives; an earlier extension can transform text before that event
reaches this extension, which is not distinguishable through the public API. Place
Common Memory before input-transforming extensions and treat earlier extensions as
trusted host components. Transformations after its capture (including built-in prompt
templates), mixed queued authorities/scopes and ambiguous candidates are isolated.
This is conservative host-event provenance, not proof against a malicious extension.
Mixed/image input is quarantined with complete text and an unsupported-content marker;
image blobs are not collected. Assistant context is omitted; prior processed user
context is limited to two same-session/scope turns marked context_only.

Manual edits to a document invalidate its title-based source links. On the next
committed maintenance, its stale links and associated processed observation bodies
are conservatively cleared in the recoverable receipt; current Markdown and other
documents are not deleted. This avoids retaining orphan evidence after a manual
rename followed by forget, at the cost of that document's short-term evidence buffer.
Advanced library configuration exposes `documentSoftBytes`, `documentHardBytes`,
`retentionMs`, `deadlineMs` and `maxRequestBytes` on Writer. Pi compatibility is pinned
to 0.84.4, whose callback/queue ordering was inspected for this implementation.
