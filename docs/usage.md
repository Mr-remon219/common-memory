# Common Memory v0.3 — 使用与配置

Durable, user-owned memory maintenance for Pi and local MCP hosts, plus authorized
read-only disclosure of the resulting Markdown to Pi, Codex CLI and other local MCP
consumers. Markdown is the authority for current long-term content; SQLite stores
pending deliveries, observations, jobs, leases, source links and recovery metadata.
There is no Fact/Recall/Undo compatibility layer, search index, temporary memory
product, or resident background service. Reading returns the current documents as
they are; there is no retrieval ranking.

Init v0.1 (`docs/init-v0.1-design.md`, `docs/init-v0.1-verification.md`) adds the
cross-agent loop: another agent (ChatGPT desktop) imports its existing understanding
through `memory_init`, the user imports local Markdown files with `common-memory import`,
the unchanged Writer decides what to keep from either, and Codex CLI (native session hooks or MCP `memory_read`)
and Pi (system-prompt injection) read the same canonical files. On Windows, Common
Memory runs inside WSL and the ChatGPT/Codex desktop app reaches it through `wsl.exe`
(`common-memory mcp-config --wsl`).

配套的 Writer 评测规范已迁移到独立仓库：[Memory Benchmark](https://github.com/Mr-remon219/memory-benchmark)。

## Setup

Requires Node.js 24. Installation: `npm install -g common-memory-core@0.3.1`.
The following TUI describes the current source. Source contributors use
`npm ci && npm run build`, then `node dist/cli/main.js`.
**`common-memory` is the single entry for interactive management.** First run selects
Provider → Base URL → hidden API Key → Model, then offers Pi, Codex and ChatGPT for
multi-select automatic integration and exits. Presets prefill an editable URL and
load the model list from that URL; Custom asks for the model name without discovery.
Space toggles Agent selections; Enter applies them. Later launches open the main TUI
without repeating setup. An interrupted setup resumes its pending integration step.
Model discovery runs only when entering model selection, never on ordinary configured
startup or in runtime. Model & Configuration → Change Model / Provider reopens the
same model flow. See [TUI flow and integration limits](tui-workbench.md).
The wizard commits `~/.common-memory/config.json` and private `.env` credentials
recoverably (`COMMON_MEMORY_HOME` overrides this location). Presets choose supported
protocols; Custom uses Chat Completions. Technical configuration may set `remote.api`
explicitly (omitted means `responses`).
Responses uses strict Structured Outputs; `chat_completions` uses JSON object mode
with the complete maintenance schema in the system message. Both use the same Core
validation and commit path. Keys are never stored in canonical memory.
V2 requires configuration `schemaVersion: 2`; pre-V2 configuration/data is not migrated
or automatically deleted. Existing V2 configurations remain valid; the V2 jobs table
receives an idempotent, transactional nullable diagnostic column when opened.

Current Configuration displays the full configuration without revealing secrets;
advanced fields in `remote` remain technical `config.json` options for editing.
The wizard requests a key explicitly and records `apiKeySource: "private-env"`
with a generated credential name, preventing inherited provider keys from replacing it.
Absent that marker, legacy configurations keep process-environment key precedence.
The wizard preserves unrelated configuration and clears incompatible thinking/effort
options when choosing a model. The following fields remain available for technical configuration:

| Field | Accepted values / effect |
| --- | --- |
| `api` | `responses` (default) or `chat_completions`; no runtime fallback |
| `preset` | Optional provider identity recorded by setup; `custom` keeps an explicit custom identity |
| `apiKeySource` | Optional `private-env`; new setup reads its private key only; omission preserves legacy precedence |
| `maxOutputTokens` | Integer 1–16384; default 4096; `max_output_tokens` for Responses, `max_tokens` for Chat |
| `reasoningEffort` | Responses only: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; sent as `reasoning.effort` |
| `thinking` | Chat only: `{ "type": "enabled" }` or `{ "type": "disabled" }` |
| `enableThinking` | Chat only: boolean, sent as `enable_thinking`; mutually exclusive with `thinking` |

Unconfigured thinking/effort fields are omitted. The endpoint and model must support
the selected fields; there is no brand detection, automatic parameter translation or
arbitrary body-field forwarding. The default Writer deadline remains 60 seconds.
Current provider evidence and the reusable verification procedure are recorded in
[Provider verification](provider-verification.md); earlier experiments remain in
[Init v0.1 closeout verification](init-v0.1-closeout.md).

Selecting Pi during setup or in Agent Integration automatically installs the Pi
wrapper for supported Pi 0.84.4. The package's
`pi.extensions` entry also remains available for manual/legacy deployment; do not load
both copies. It records input origins, durably records actual user `message_end` deliveries,
then binds stable transcript entries after Pi appends them. Assistant failure does not
discard delivered evidence. Input alone is not evidence. Ambiguous, detectably transformed, or
extension-originated messages are quarantined rather than silently trusted. No
assistant/tool/system/thinking/compaction text is supplied as new evidence.

The extension reads authorized memory once when the process first starts the session,
including startup with resumed history. It freezes only the Common Memory appended
block, combining that block with the host's current `event.systemPrompt` on each
`before_agent_start`. Reload, same-process resume, compact, branch navigation, fork
and `/new` do not trigger a new automatic read. Each session has separate counters.
The native `memory_read` tool remains available for explicit fresh reads, with the
same guidance and scope rules as MCP. Personal recommendations need a read when
relevant personal context is missing; generic explanations do not mechanically read.
Missing fields are unknown and memory content is data, not instructions.

Pi and Codex now use a durable session cache. One delivered user interaction counts
once at final settled, including steering and delivered follow-ups. The tenth settled
interaction immediately seals a session-only batch. A 21-turn session produces
10 + 10 + a one-turn exit tail. The logical batch may need several Writer requests,
always split between whole interactions; a single oversized interaction is retained
locally and quarantined. Assistant and tool text is context only, with separate
`conversation_context` disclosure permission (not added to existing configurations).
See [session design and validation](session-integration.md).

Optional `sessionCache` limits (omitted fields use these defaults):

```json
"sessionCache": {
  "maxSessionBytes": 8388608,
  "maxTotalBytes": 67108864,
  "contextTailTurns": 2
}
```

These are conservative engineering defaults, without capacity measurements or a
claim that two turns resolve every reference. Limits account for cached bodies,
input candidates, deliveries and Codex inbox bodies. Capacity rejection retains
existing content and recovery state; terminal metadata can still be persisted.
Old configurations remain valid and do not acquire `conversation_context` permission.

## Model network configuration

Common Memory owns one outbound client per configured model, shared by the CLI, MCP
and Pi paths. Open Model & Configuration from `common-memory`, then choose network
settings to select a route. `common-memory config --network` remains a compatibility
shortcut. This changes model calls only; it does not configure the host's other
network clients.

| Mode | Request route |
| --- | --- |
| `direct` | Independent direct Agent; ignores HTTP/ALL proxy variables and the host global dispatcher |
| `env` | HTTPS: HTTPS_PROXY → HTTP_PROXY → ALL_PROXY; HTTP: HTTP_PROXY → ALL_PROXY; honors the supported NO_PROXY rules |
| `custom` | Explicit HTTP/HTTPS proxy; optional own bypass list, independent of host NO_PROXY; SOCKS5 is experimental |
| Old config without `remote.proxy` | Legacy host route, whose actual behavior is unknown to Common Memory; preserved until network settings are explicitly saved |

New installations default to `remote.proxy: {"mode":"env"}`. Existing schemaVersion 2
files retain field absence on load/save and ordinary API configuration, so upgrading
alone does not change their route. Legacy borrows the fetch captured at client creation
and preserves historic private environment loading, except for newly reserved network
secret names. It is a compatibility exception to network isolation.

In the new modes, proxy variables and API keys are read locally with **process env
before Common Memory's private `.env`**. For each standard proxy variable group, the
process source wins before checking lowercase/uppercase spelling; lowercase wins
within that source. A present empty value clears that group. No new-mode loading
changes `process.env`, global fetch, global dispatchers or global certificate trust.
The route and connections are fixed for the client's lifetime, including retries;
restart active MCP/Pi clients after changing configuration.

The wizard saves a custom proxy URL only as private `COMMON_MEMORY_PROXY_URL`, with
`remote.proxy: {"mode":"custom","urlEnv":"COMMON_MEMORY_PROXY_URL"}` in JSON. URL
credentials are supported. Optional extra CA certificates are referenced through
`remote.caFileEnv: "COMMON_MEMORY_CA_FILE"`; the private value is a PEM file path.
The CA file is limited to 1 MiB and is added to Node's default trust only for this
client. Certificate and hostname verification stay enabled. Other custom `urlEnv`
or `caFileEnv` names are read from external process env only. Reserved private network
keys are never exported by the legacy loader either.

NO_PROXY (or custom `noProxy`) accepts comma/whitespace-separated hostnames,
`example.com`, `.example.com` and `*.example.com` (apex plus subdomains), exact IPv4/
IPv6, optional ports and standalone `*` anywhere in the list. IPv6 ports require
brackets. Matching normalizes case, IDNA, trailing dots and IP spelling; it compares
effective ports, so HTTPS with omitted port matches `:443`. It performs no DNS lookup:
`localhost` does not imply `127.0.0.1` or `::1`. **CIDR ranges, URL/path entries and other
wildcards are rejected** with `no_proxy_invalid`; they are not silently ignored.
An environment containing CIDR entries needs an explicit supported bypass list or a
custom route. A failing selected proxy never falls back to direct.

Windows/macOS GUI processes can inherit different environment variables from terminals;
configure the private settings when that is the desired common source. WSL uses its
own visible environment and reachable proxy address; Common Memory does not guess a
Windows host address or copy Windows proxy settings. OS VPN/TUN routing still applies
in every mode. PAC/WPAD, SOCKS4 and NTLM/Kerberos are unsupported.

Current Configuration describes configuration, selection/bypass reason and actual
storage paths without opening network connections; the `status` command retains
technical diagnostics. The model connection test in Model & Configuration (also
available as `network-test`) explicitly sends a small synthetic model API request
without opening SQLite or writing memory. Its success does not prove
Writer commits. Proxy authentication (`PROXY_AUTHENTICATION`, `proxyStatus:407`) is
separate from provider API key authentication (`AUTHENTICATION`, `httpStatus:401/403`).
Errors expose controlled stages/reasons, not proxy credentials or provider bodies.

Configured model clients and configured Writers expose async `close()` and own their
connections. CLI/MCP/Pi await shutdown. Integrators creating them directly must also
`await close()`; a plain `Writer` still borrows its `MemoryModelPort` and does not close
caller-owned resources. The port itself remains analysis-only.

Research, explicit environment limits and acceptance evidence:
[network design and review](outbound-network-design.md).

## Interactive management

Run **`common-memory`** in a terminal. First run completes model configuration and
Agent selection; once initialized, each launch opens these three columns:

| Menu | Tasks |
| --- | --- |
| Agent Integration | Pi, Codex and ChatGPT availability and managed selection; Space toggles, Enter applies installation/removal differences |
| Memory Control | Search / View Memory, Adjust Memory, and processing status with continuation/retry for pending requests |
| Model & Configuration | Current Configuration, Change Model / Provider, network settings, model connection test, and complete uninstall |

Agent Integration starts from the current managed installation state. Checking a new
Agent installs its integration; unchecking an installed Agent removes that owned
integration; keeping a selection retains it. For example, changing Pi + Codex to
Pi + ChatGPT keeps Pi, removes Codex and installs ChatGPT. Esc cancels uncommitted
selection changes. Unavailable clients remain visible with their limits. The installer
does not take over unmanaged entries. Codex and ChatGPT may share one owned MCP
resource, which remains installed while either needs it. Installation-file checks
do not prove a running client or host Hook trust.

Search / View Memory reads the current authorized Profile, Preferences and registered
project Markdown. Keyword search performs local text matching and lets the user open
matching documents; it adds no model call, retrieval ranking or index. Browsing is
paginated and read-only. Empty memory and no-match results have explicit empty states.
Search, browsing and Current Configuration neither initialize absent storage nor
open SQLite. Current Configuration shows paths, data size, provider/model, key status,
network information and the complete configuration with secrets concealed.

Adjust Memory accepts natural-language corrections, forget requests and changes such
as promoting a project preference to global scope. Users can choose personal memory
or a registered project authorized for reading and writing before submitting. The same configured Writer
and Core interpret and validate each request, including the existing rules for
promotion; selecting a project grants no new read or write permissions. Input is an
actual local user expression (`interactive`), not an imported document or another
agent's summary. Authorization and sensitive-input checks precede admission. Enter
submits after a short disclosure notice; cancellation after submission does not
remove the durable request. A processed request may have been ignored: inspect the
actual memory result. Idle leases, backoff, failures and cancellation are never
reported as successful edits. Processing status, continuation and failed-job retry
remain available under Memory Control → Adjust Memory → Processing Status, so incomplete requests do not require a new
command or duplicate submission. Quarantine and existing leases are not bypassed.
There is no Markdown editor or separate Delete Memory button.

Change Model / Provider reuses the setup model form and returns to management after
saving; it does not repeat Agent installation. Use arrows and Enter; Esc returns one
level and exits at Home. The home menu remembers the last action.

Complete uninstall is available in Model & Configuration. It removes owned
integrations, the exact global npm installation and related config. Memory Data is
confirmed separately and retained by default, including durable SQLite. Source/npx
ownership, unmanaged legacy references, unsafe deletion paths and active Writer
leases fail closed. Individual Agent removals use Agent Integration checkboxes.
See [installation, removal and verification boundaries](tui-workbench.md).

The interface requires both stdin and stdout to be TTYs. No-argument non-TTY
invocations print guidance; direct `config` wizards fail rather than waiting. The
`show`, `config` and `uninstall` commands remain compatibility shortcuts. `show`
outside a TTY keeps its plain consumer output; `show --plain` forces plain output
even in a terminal. Existing scriptable commands and machine protocol entries remain
available.

## Commands

These remain supported for automation, protocol launch and compatibility shortcuts.
Interactive Agent, memory and model management use `common-memory`; users do not need
the other commands for those tasks. The integration sections below also document
manual deployment for unsupported or separately managed hosts.

```sh
common-memory
common-memory config
common-memory config --network
common-memory uninstall
common-memory status
common-memory network-test
common-memory show [--plain | --workspace /absolute/project/path]
common-memory import <file.md> [--workspace /absolute/project/path] [--author user|agent|third_party|mixed|unknown] [--label <text>] [--no-wait]
common-memory flush
common-memory session-drain [--home <absolute-path>]
common-memory retry <dead-job-id>
common-memory project register /absolute/project/path "Display name"
common-memory project list
common-memory project remove <id>
common-memory mcp-config [--wsl] [--distro <name>] [--user <name>] [--workspace /absolute/project/path]...
```

Plain `show` output (`--plain`, non-TTY, or explicit `--workspace`) prints the memory
directory and exactly what consumers (MCP `memory_read`, Pi) receive for `global` plus
the optional registered workspace, using the same authorization. The canonical files themselves are plain Markdown under
`<dataRoot>/memory/` and can be opened with any editor.

### Importing a Markdown file

`common-memory import <file.md>` brings one local Markdown file into memory through the
same Writer that handles user turns and Init. It never copies the file into
`profile.md` or bypasses the Core. The import step is input preprocessing only:

- The file must be a regular `.md`/`.markdown` file (no symlinks), strict UTF-8 without
  NUL bytes, non-empty after trimming, and at most 256 KiB. Anything else is rejected
  with a code (`FILE_NOT_FOUND`, `UNSUPPORTED_FILE_TYPE`, `INVALID_ENCODING`,
  `EMPTY_DOCUMENT`, `DOCUMENT_TOO_LARGE`) before anything is queued. Nothing is truncated.
- A file that fits the 32 KiB per-item budget is one observation, verbatim. Larger files
  are split only at Markdown structure: headings start new units, blank lines separate
  paragraphs, fenced code is never split, and whole sections stay together when they fit.
  Every part records the ancestor headings it sits under (`heading_path`) and its position
  (`part i of n`). A single paragraph or fence larger than the budget rejects the whole
  import (`IMPORT_CHUNK_TOO_LARGE`); an unterminated fence makes the rest of the file one
  fence. The 32 KiB budget is fixed; with a lowered `disclosure.maxTotalBytes` the Writer
  may still quarantine a part that does not fit its request (`OVERSIZED_COMPLETE_TURN`).
- The Writer's outbound safety scan runs before queuing; a violating part is reported as
  `SENSITIVE_CONTENT_REJECTED part i/n: <rule ids>` and the file is not imported.
- `--author` records who the importer says wrote the file (default `unknown`), `--label`
  a display label (default the file name). Both are recorded metadata for the maintainer;
  neither grants authority. Even `--author user` remains `document_import`, not a user
  statement, because Markdown is a format and choosing to import a file is not asserting
  each sentence in it.
- Identity is the content digest within the target context (`md-<sha256>`): the same bytes
  under another file name, label or author are the same material (reported as a duplicate,
  nothing new is queued, the original metadata stays); changed bytes are a new import.
  Scope comes from `--workspace` (a registered project in `disclosure.allowedScopes`) or
  defaults to `global`.

All parts are queued in one transaction with a flush request, then the command runs the
Writer loop like `flush` and prints per-part states (`pending`, `claimed`, `processed`,
`quarantined`, `dead`), the documents each part is retained in, and a final `complete`
flag that is true only when every part was processed. Parts are committed batch by batch
with their own receipts; a partially processed import is reported as incomplete (exit
code 1), never as success. Re-running `import` on the same file resumes pending or
retrying parts (dead jobs need `common-memory retry <job-id>`); a quarantined part is
final for that content and needs a changed file. `--no-wait` only queues. Enable the
provenance first:
`disclosure.allowedProvenance` in config.json must contain `document_import`, otherwise
`IMPORT_DISABLED`. Text inside the file is data: memory
commands, links and code in it are never executed or followed, and the import cannot
forget, remove or replace Sections that user turns produced (see "What Init means").

Project IDs are generated locally. Registry matching uses real paths and the longest
ancestor, frozen at capture time. Registration alone grants no permission: separately
add `project:<id>` to `disclosure.allowedScopes` and `writableScopes` in config.
Removing a registration leaves its Markdown intact. `status` reports pending,
quarantined, dead jobs and unbound deliveries without printing raw conversations.
It also shows the config path and resolved storage paths (including symlink targets);
absent storage is displayed without creating it. `flush` exits 1 if this invocation
fails, is cancelled, quarantines an observation, or ends with pending/claimed/dead
observations. An idle scheduler waiting for backoff or an active lease is incomplete.
Historical quarantine and retired jobs do not block an otherwise empty queue; flush
does not bypass backoff or take another process's lease.
Pi also provides `/memory-flush` for queued maintenance. It does not seal an unfinished
session batch. On actual quit, Pi hands off the tail and wakes a detached consumer;
reload and session switching preserve the open cache. `common-memory session-drain`
recovers durable handoffs and waits through retry backoff and leases.

## MCP access (stdio)

Build with `npm ci && npm run build`. Configure Common Memory using the existing
CLI, then give your MCP host an explicit command and argument array. Node 24 is
required. No running Pi process is needed; the existing Pi peer/package layout is
unchanged. The SDK stdio entry serves modern and legacy clients. No HTTP port,
automatic host installer, Roots discovery, Resources, Prompts or retrieval is added.

### Capability profiles

Each MCP process registers only the tools its launch arguments allow. `--capability`
is repeatable; the default without it is `relay`, the pre-existing behaviour.

| `--capability` | Tools registered | Needs Writer / API key | Intended host |
| --- | --- | --- | --- |
| `relay` (default) | `memory_submit_user_turn`, `memory_status` | yes (background processing) | trusted local agent relaying verbatim user turns |
| `init` | `memory_init`, `memory_status` | yes | ChatGPT desktop: one-shot import of its existing understanding |
| `read` | `memory_read`, `memory_status` | **no** (never opens the runtime database) | Codex CLI and other read-only consumers |

Capability is fixed per process at launch; a tool argument, client-reported name or
prompt can never widen it. Run one process per host role. Where two hosts share one
configuration file (see Codex below), use the host's own allow list and profiles as the
second layer.

For project input, use `--workspace /absolute/project/path` (repeatable). Register
projects with the existing CLI and separately authorize their disclosure/write scopes.
Use `--global` explicitly to allow global contexts. There is no cwd fallback. Each call
selects an allowed `contextId`; changed/unregistered workspace mappings are rejected
rather than silently rebound. Project source does not prohibit authorized Global
promotion: the existing Writer still decides applicability. Reading follows the same
contexts: a process launched for workspace A never returns project B's document, and
a process without `--global` never returns Profile/Preferences.

The server publishes MCP `instructions` describing when to use its tools. Tool discovery
and proactive calls depend on the host and model; configuring MCP alone does not
guarantee a read before an answer. Native Codex hooks below inject memory independently
of tool calls. Memory content is data, never agent instructions.

### Tools

- `memory_status {}`: this connection's capabilities, enabled features and allowed
  context IDs.
- `memory_submit_user_turn { submissionId, conversationId?, contextId, text }`
  (`relay`): submit one **complete user expression verbatim**, not an assistant summary
  or a Markdown operation. IDs must be 1–128 ASCII letters/digits/underscores/hyphens.
- `memory_init { importId, contextId, sourceLabel, basis, understanding, gaps? }`
  (`init`): import another agent's **visible existing material, quoted or faithfully summarized** of the user (`global`) or the current
  project (`project:<id>`). `basis` ∈ `saved_memories | chat_history |
  current_conversation | project_context | mixed | unknown`; `understanding` ≤ 32 KiB;
  `gaps` describes what the agent could not access. The payload is stored as one
  `agent_import` observation. `sourceLabel` is a recorded label, not an identity.
  Reuse `importId` on retry: identical payloads are duplicates, changed payloads are
  `SUBMISSION_CONFLICT`. Init requests an immediate flush, so the Core processes it at
  the next stable boundary instead of waiting for the usual thresholds.
- `memory_read { contextId? }` (`read`): current Profile and Preferences for `global`
  and the project document for an allowed project context; without `contextId`, every
  allowed context. Returns Markdown plus `{ documents: [{ target, content, bytes,
  empty }], empty }`. Documents are returned whole (the Writer keeps each ≤ 16 KiB);
  an empty result says that nothing is stored so consumers do not invent facts.
- `memory_status { submissionId, conversationId? }` / `memory_status { importId }`:
  that item's `state` (`pending`, `claimed`, `processed`, `quarantined`, `dead`), the
  documents it is currently retained in (`retainedIn`, derived from Section source
  links, never titles or bodies), the existing `issue` code, and `diagnostic`
  (`stage`, local `reason`, optional `httpStatus`, `retryable`). It also returns
  `jobId`, `jobState`, `attempts` and `retryAt` (Unix milliseconds, null unless
  waiting for a job retry). Diagnostics follow the current linked job and survive
  restart; processed observations hide earlier failures, while local job history
  retains them. Provider messages/bodies are never persisted as diagnostics.
  `retryable` describes the adapter's advice and does not change Runtime scheduling. `processed` with an
  empty `retainedIn` means the Core kept nothing (ignored or reorganized only).

### What Init means

Init is a product action — "bring what another agent already understands about me
into my memory" — not MCP initialization and not a claim to export that agent's
internal memory. Record the material actually visible in this session, its source,
conditions and gaps; a product or mode name does not establish source or coverage.
[Official documentation](https://learn.chatgpt.com/docs/customization/memories)
separates ChatGPT memory from local Codex memory, while the
user-confirmed Work-local session read local Codex material and completed Init
([evidence and limits](init-v0.1-verification.md#work-local-evidence-2026-09-08)).
Whether that session also received cloud memory is unknown. The Core treats the submission as
untrusted agent-reported data: the maintainer receives `source_kind: "agent_import"`
with the label, basis and gaps, must keep the source nature visible in any retained
Section (for example "Imported from chatgpt-desktop on 2026-09-07 …"), must not
present it as the user's words, and must not overwrite conflicting user-stated content.
The executor enforces the hard part structurally for every import kind (`agent_import`
and `document_import` alike): imports are batched separately from user turns, and a
decision backed only by import evidence (or an evidence-free `maintain` in an import-only
batch) may append new Sections or rework Sections whose every linked source is itself an
import, but is rejected if it tries to `forget` (`UNAUTHORIZED_FORGET_EVIDENCE`), remove,
or replace a user-derived or unlinked Section (`UNAUTHORIZED_IMPORT_OVERWRITE`). A Section the user edited by hand counts as the
user's even if an import created it: its stale title links are not trusted. What the
executor cannot judge is semantic: whether an added assertion has factual support,
whether the claimed source is correct, whether a new attributed Section contradicts a
user-stated one, or whether first-person text in a file describes the user; the packaged
maintainer instructions make those the model's responsibility and require visible
attribution. Init therefore never clears existing documents or
runtime state; existing safety scanning, size limits, scope authorization, CAS, lease
fencing and recovery apply unchanged. Init does request a flush, which — like
`/memory-flush` — also lets already queued user turns be processed at the next stable
boundary. There is no preview or approval queue in the Core: the user's explicit
request plus the host's approval prompt for non-read-only tools are the confirmation,
and `memory_status.retainedIn`, `common-memory show` and the Markdown files are the
post-hoc review.

Init is enabled only when the process was launched with `--capability init` **and**
`disclosure.allowedProvenance` in config.json contains `agent_observation`; otherwise
`memory_init` returns `INIT_DISABLED`.

### Migrate selected, checkable material

1. Save the original Memory Summary or legacy Saved Memories actually visible to the
   account, including available dates and source references. The [Memory FAQ](https://help.openai.com/en/articles/8590148)
   says the summary omits some memory and response source lists may be incomplete.
   For missing topics, ask the source agent targeted questions and preserve checkable
   references; leave unsupported new guesses in separate review notes.
2. Review the selected material before submission. Preserve historical goals, dates,
   conditions, tentative claims and project boundaries. Put what the agent cannot
   access in gaps; “unknown” does not mean the user has no such history. Exclude this
   migration's connection, import and readback status. Approval to migrate does not
   make every claim true.
3. Use `common-memory import selected.md --author agent --label "ChatGPT visible memory"`
   for user-selected Markdown generated by an agent (choose the actual author class
   for other material). It remains `document_import`, authorized through
   `document_import` in `disclosure.allowedProvenance`. An agent's submission uses
   `memory_init`, remains `agent_import`, and requires `agent_observation` authorization.
   Direct quotation does not turn either import into authenticated user statements.
4. An isolated trial is recommended: configure a separate `COMMON_MEMORY_HOME` with
   `common-memory config` and verify its `dataRoot` is also a new temporary directory.
   Merely changing the home while copying a production `dataRoot` does not isolate it.
   Authorize the chosen scope/provenance and remote provider there, then run the
   existing import and `show` commands against that configuration. For MCP, launch
   the trial process with that separate configuration and verify the generated
   `mcp-config` paths. Do not connect consumers to the trial store.
5. Compare the trial result with the selected sources. Submit through the same
   existing entry point to the intended destination and review **that destination's**
   `common-memory show` output (with `--workspace` for a project). Check omissions,
   altered conditions, scope, unknowns and new assertions. A trial cannot guarantee
   identical model decisions when rerun against the destination's existing state.

The Init guidance is a **soft semantic defense**: it cannot prove provenance, prevent
all unsupported facts or semantic conflicts, or replace result review. v0.1 adds no
migration state machine, consumer pause/resume interface or Core approval queue.
There is no full-chat parser, profile generator or remote server in this workflow;
remote MCP would not itself expand the source agent's visible memory.

### ChatGPT desktop app (init only)

The ChatGPT desktop app configures MCP servers for its Codex host in the same
`config.toml` as Codex CLI (Settings → MCP servers, or edit the file). Add an
init-only server; the host prompts before non-read-only tools:

```toml
[mcp_servers.common_memory_init]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/common-memory/dist/cli/main.js", "mcp",
        "--client-id", "chatgpt-desktop", "--capability", "init", "--global"]
env = { COMMON_MEMORY_HOME = "/absolute/path/to/.common-memory" }
default_tools_approval_mode = "approve"
```

When the desktop app runs on Windows and Common Memory lives in WSL, use the WSL bridge
described under "Windows / WSL deployment" below: run `common-memory mcp-config --wsl`
inside WSL and paste its output. It pins the distribution, Linux user, configuration
directory, dataRoot, node binary and CLI entry, so the host cannot land on another store.

Then, in a chat that can use that host's MCP servers, ask: “把本次实际可见、已选定的既有理解导入
Common Memory；保留来源、时间、条件和不确定性，列明无法访问的材料，排除本次迁移执行状态。” The agent should call `memory_init`, then `memory_status` with the same
`importId` to report what was retained. Use `common-memory` → Memory Control locally to review.
ChatGPT web and the desktop **Chat** mode do not read this configuration; use the
selected Markdown workflow above for this version. A remote HTTPS connector
is outside this version and would not guarantee access to more source material.

### ChatGPT Work local sessions and explicit refresh

Build first, then generate a reviewable bundle for the **actual agent environment**:

```sh
# macOS agent + runtime, or agent + runtime in the same WSL environment:
common-memory work-config --mode posix --output /absolute/new/bundle
# Native Windows agent with this runtime inside WSL:
common-memory work-config --mode windows-wsl --distro Ubuntu --user linux-user \
  --output /mnt/c/Users/you/common-memory-bundle \
  --bridge-path 'C:\Users\you\common-memory-bundle\common-memory-bridge.ps1'
```

Choose the mode from the agent process and its configuration directory. Terminal type
and `WSL_DISTRO_NAME` alone do not identify where the desktop agent runs. Linux POSIX
configuration validation does not establish Linux Desktop product support. The bridge
pins absolute `wsl.exe`, distro, user, Node, CLI and Common Memory home. Store its
PowerShell launcher on a Windows local path; `--bridge-path` defaults to the Windows
translation of the output path. UNC locations may require signing under
the machine's execution policy. The generator does not change that policy.

Inspect `common-memory.config.toml`, then merge it into the actual Work agent's
configuration, and install `skills/memory-refresh` in that agent's skills directory.
Use repeatable `--workspace <absolute-runtime-path>` for registered project read access.
Review and trust Hook commands through `/hooks`. Generated files never overwrite
existing files. Work gets independent read and init MCP processes. The existing
`chatgpt-desktop` import identity is preserved for retry receipts; session capture and
read use `chatgpt-work`. Ordinary Chat is outside this integration.

For Codex, `codex-config --mode posix --output /absolute/new/bundle` generates the
same explicit Skill and a profile with init disabled. The no-argument form still
prints configuration. Use `--mode windows-wsl` with the bridge options for a native
Windows Codex host. Keep Work and Codex profiles separate when sharing a config home.

`/memory-refresh` has `allow_implicit_invocation: false`. Its generated command calls
`session-refresh --home <absolute-path> --client <client>` using the host process and
`CODEX_THREAD_ID`. Missing or nonmatching identity fails; cwd alone never selects a
session. Reading and replacement are transactional: failure leaves the prior snapshot
and pending delivery intact. `PostToolUse` injects the new block, with the next
`UserPromptSubmit` as fallback. Refresh does not reset the ten-turn count or import
anything. Pi provides the same command natively and replaces its frozen system block.

A live activation survives switching away, unsubscribe/resubscribe, same-process
resume, compact, clear and reload. A real `SessionEnd` closes it and drops its snapshot;
a subsequent startup/resume creates an independent activation while the old durable
inbox and tail drain remain recoverable. New-process resume reads once. Historical
messages may retain old snapshots: the host API appends context, while the adapter
owns and replaces one active slot. See [session integration](session-integration.md)
for validation and remaining real-UI limitations.

### Codex CLI (session hooks and read-only MCP)

For automatic injection, build Common Memory and run `common-memory codex-config`
(or `node dist/cli/main.js codex-config`). Save its stdout as
`common-memory.config.toml` under the **actual Codex CLI `CODEX_HOME`**
(default `~/.codex`). Inspect and merge any existing file with that name; do not
blindly overwrite it. The generator only prints configuration: it does not edit
base configuration, profiles or the hook trust store.

Launch `codex --profile common-memory`, then use Codex's official `/hooks` interface
to review and trust the generated commands. No trust bypass is generated.
The commands pin the current Node binary, built CLI entry and Common Memory
configuration directory as absolute, POSIX shell-quoted paths. Regenerate after
moving the installation or changing Node or `COMMON_MEMORY_HOME`.
Codex CLI and Common Memory must run in the same POSIX environment, including WSL;
macOS uses the same direct launch. For a native Windows agent with a WSL runtime, generate the bridge bundle below.

The generated synchronous hooks cover `SessionStart`, `UserPromptSubmit`, `Stop`,
`PostToolUse`, `Interrupt` and `SessionEnd`, with a three-second timeout. They use the local SQLite
FULL-synchronous durable inbox, then launch `session-drain` detached with independent
stdio. The inbox contains the transcript tail itself, so normal exit does not depend
on the transcript surviving. Consumers delete that copy only in the transaction that
admits it into the session cache. No model runs in the hook process.

Only the first qualifying `SessionStart` (`startup` or `resume`) for the process and
activation reads memory. Compact/clear/reload reattach the cached block without reading canonical files; ordinary turns do not repeat it. Startup
output remains bounded to 64 KiB and hook input to 1 MiB. Automatic snapshots are
frozen; call MCP `memory_read` for an independent current read, or explicitly invoke `/memory-refresh` to replace the frozen slot. Read failure returns
a controlled unavailable block. Ingress/protocol/capacity failures exit nonzero.

The rollout parser is isolated at `src/cli/codex/transcript-0.153.4.ts`; it accepts
only Codex CLI 0.153.4 metadata. User delivery requires `user_message` or `item_completed/UserMessage` events matching the separately recorded
UserPromptSubmit candidate for that turn, never arbitrary `response_item` user content, hook context, environment messages or
compaction summaries. `task_complete` / `turn_aborted` seal interactions. Stop starts
completion reconciliation immediately; a delayed final record needs no next prompt.
Unconfirmed completion keeps its durable watch for a later `session-drain` retry;
a reconciliation attempt is bounded to 60 seconds. Unknown formats do not advance
the cursor. Linux/WSL process identity uses boot ID, host PID and start time; native
macOS uses the host PID and process start time. The Windows bridge passes the native host PID and creation time, and converts cwd/transcript paths into the fixed WSL runtime.

Protocol reference: [official Codex hooks](https://learn.chatgpt.com/docs/hooks).
The earlier `scripts/smoke-codex-hooks.py` repeated-snapshot assertions are historical
and superseded by the session tests; they are not validation of this implementation.
Current synthetic coverage and remaining real-client gaps are recorded in
[session integration](session-integration.md). No personal data or live model
calls are needed for the tests.

MCP-only users can keep the read-only setup below; session hooks and MCP can coexist.
Hooks do not add MCP capabilities. To keep a desktop init server out of Codex, merge
`mcp_servers.common_memory_init.enabled = false` at the correct TOML table location
(or launch with `-c mcp_servers.common_memory_init.enabled=false`).


```toml
[mcp_servers.common_memory]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/common-memory/dist/cli/main.js", "mcp",
        "--client-id", "codex-cli", "--capability", "read", "--global",
        "--workspace", "/absolute/project/path"]
env = { COMMON_MEMORY_HOME = "/absolute/path/to/.common-memory" }
enabled_tools = ["memory_read", "memory_status"]
default_tools_approval_mode = "auto"
```

`--workspace` is optional and must be a registered project whose `project:<id>` is in
`disclosure.allowedScopes`. The process is read-only by construction (server side) and
`enabled_tools` repeats that on the host side. If the same `config.toml` also holds the
ChatGPT init server, keep Codex CLI from seeing it with a profile file
`~/.codex/memory-reader.config.toml` containing
`mcp_servers.common_memory_init.enabled = false` and run `codex --profile
memory-reader`, or pass `-c mcp_servers.common_memory_init.enabled=false`. Disable
Codex's own local memories (`features.memories = false`) when you need to prove that
an answer came from Common Memory. `common-memory mcp-config` prints this block with the
paths of the runtime you are actually using.

### Windows / WSL deployment

On Windows, Common Memory runs in WSL only: one configuration authority
(`COMMON_MEMORY_HOME`, default `~/.common-memory` of the Linux user), one dataRoot, one
build. PowerShell and the ChatGPT/Codex desktop app are thin bridges that start the WSL
process with `wsl.exe`; there is no Windows-native Core, second store, installer or
resident service. Different MCP processes still start per host role (`init`, `read`) and
share the data the Core manages.

Inside WSL, after `npm run build` and `common-memory config`:

```sh
common-memory mcp-config --wsl [--workspace /home/<user>/project]
```

prints ready-to-paste `[mcp_servers.*]` blocks of the form

```toml
[mcp_servers.common_memory_init]
command = "wsl.exe"
args = ["-d", "Ubuntu", "-u", "<linux-user>", "-e", "/usr/bin/env",
        "COMMON_MEMORY_HOME=/home/<linux-user>/.common-memory",
        "/home/<linux-user>/.local/share/fnm/node-versions/v24.20.0/installation/bin/node",
        "/home/<linux-user>/common-memory/dist/cli/main.js", "mcp",
        "--client-id", "chatgpt-desktop", "--capability", "init", "--global"]
default_tools_approval_mode = "approve"
```

with a header recording the distribution (`WSL_DISTRO_NAME`), Linux user, configuration
directory, dataRoot, node and CLI entry that were in effect. `-d`/`-u` fix the
distribution and user instead of relying on the WSL defaults; `-e` runs no login shell,
so `PATH` and shell profiles are unavailable and every path is absolute. Paste the blocks
into the Windows `%USERPROFILE%\.codex\config.toml` (ChatGPT desktop / Codex host). The
WSL `~/.codex/config.toml` used by Codex CLI inside WSL takes the non-`--wsl` output.
Workspaces are WSL paths registered with `common-memory project register`; a Windows path
string (`C:\...`) is not a registered project and is rejected rather than mapped. Pi is
supported when it runs inside the same WSL distribution; Windows-native Pi is not covered.
`docs/init-v0.1-verification.md` records that a read-only process launched through
`wsl.exe -d Ubuntu -u <user> -e ...` returns byte-identical `memory_read` content to a
direct launch of the same store (`tests/cli/demo-and-bridge.test.ts`, skipped off-WSL).

### Relay (pre-existing)

Submissions are disabled unless `--accept-client-reported-user-turns` is set and
existing config permits user-expression disclosure. This flag explicitly trusts this
local host to relay user expressions: MCP cannot prove original user delivery or
faithful copying. The server records `mcp_user_submission`, never fabricates Pi
`rpc` delivery events. The flag gates new admissions, not retroactive revocation of
already accepted evidence. Only use trusted local agents belonging to the same user.

Use a distinct stable `--client-id` for each independent integration. Client identity
is a local namespace, **not authentication**. Reuse the same submission/conversation
IDs on retry, including after restart. Conflicting payloads are rejected. Without a
conversation ID, each submission has its own logical session. Two clients may use the
same IDs without colliding, but sharing a client ID deliberately shares that namespace.

Legacy relay sessions can share a same-scope/provenance batch under the existing
scheduler. Pi/Codex session batches are separate from relay/import and from each
other. The store is not a multi-tenant authorization boundary. All processes sharing a dataRoot must use the
same configuration authority and compatible release; stop old processes before upgrade.

Accepted means durably queued, not immediately committed. Background processing uses
the existing thresholds. Cancellation is best-effort; request cancellation after
admission does not retract evidence. Known SDK 2.0.0 limitation: cancellation with
JSON-RPC request ID `0` is ignored upstream (a same-tick call/cancel was reproduced);
use nonzero request IDs if cancellation-before-admission matters. No SDK patch or
request-ID compatibility shim is included in this first integration.
On EOF (all platforms) or SIGTERM (POSIX), the server queues a flush, aborts its own
Writer and closes after local cleanup. On Windows, Node's SIGTERM emulation kills
unconditionally: use stdin EOF for graceful shutdown; forced termination relies on
lease expiry and restart recovery. Pending work survives for the next Pi/MCP process
or `common-memory flush`.
Legacy relay/import shutdown does not launch a consumer. Session hooks/Pi quit do
launch an independent consumer, which may outlive both the host and MCP. Existing recovery wins over cancellation
once a durable commit has begun. Logs go to stderr; stdout is reserved for MCP.

Full runtime diagnostics, retry, flush, configuration and project management retain
CLI interfaces for automation. The TUI exposes day-to-day model configuration,
Agent integration, memory adjustment and pending-request handling through its three
main columns. Quotas, hot revocation,
optional-Pi packaging and broader compatibility matrices remain deferred. No personal data or live models are needed
for the MCP fake-provider protocol tests.

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

Every projected observation carries a host-assigned `source_kind`: `user_turn`
(delivered user expressions from Pi or the MCP relay), `agent_import` (an Init
submission, with `import.source_label`, `import.basis` and `import.gaps`) or
`document_import` (one part of a `common-memory import` file, with `import.source_label`,
`import.file_name`, `import.declared_author`, `import.part {index, count}` and
`import.heading_path`). The observation's stored `source` maps to one disclosure
provenance class (`user_explicit`, `agent_observation`, `document_import`); that single
mapping decides admission, batching, the import guard and authorization. A batch holds one
scope and one provenance class: user turns, agent imports and document imports never
share a batch (parts of different Markdown files may). Before any network call the Writer
checks the batch's class against `disclosure.allowedProvenance`; an unauthorized batch is
quarantined locally, one head observation per run (`UNAUTHORIZED_PROVENANCE`, like
`UNAUTHORIZED_SOURCE`), so an init-only or import-only configuration processes what it
authorizes and never discloses user turns. Import
observations may support retain with visible attribution; as sole evidence they cannot
forget, remove or replace Sections that any user turn produced (see "What Init means").
The request projection gained these fields; the response schema, receipts, database
schema and existing Markdown are unchanged and need no migration.

Scope (`global` or the current project) means applicability. Profile, Preferences and
Project Markdown are target documents, not semantic domains. The maintainer uses
non-exhaustive domains such as background/abilities, goals/learning, communication,
collaboration/decisions, technology/tools, constraints/resources and current state
as cross-document guidance, not fixed slots. It may reuse or reorganize Sections;
there is no automatic taxonomy migration and no `domain` or `memory_type` field.
Domain ≠ Admission ≠ Lifetime ≠ Scope: classification alone does not justify retention.

Runtime/database observation `scope` remains source metadata. Model observations and
context-only turns expose it as `source_scope`. Every decision requires
`applicability: "global" | "project" | "uncertain"`; global targets authorized Profile
or Preferences, project targets only the current source project's Markdown (including
project-limited personal facts/preferences), and uncertain permits only ignore.
Operations within a decision share its applicability; a batch may contain separate
decisions for different scopes. The protocol remains `memory_maintenance_v2`, but old
responses lacking applicability are rejected rather than inferred: custom model
responses must be updated. Existing Markdown, database, receipts and package exports
need no migration.

Project-source information may introduce, update, correct or qualify Global state only
through retain with remember/update/correct admission, current valid evidence and the
existing lifetime judgment. Source scope alone never promotes information. Maintain
is not promotion: it only reorganizes state already in its target document, without
introducing new information or corrections. Authorized Global maintain in a Project
batch may use `evidence: []`; any supplied evidence must be current and valid.
Retain and forget still require valid current-batch evidence, never context-only turns.

Promotion alone leaves Project Markdown unchanged. Duplicate cleanup requires an
explicit, separate Project maintain decision that preserves unrelated content, not
forget; both scopes may commit atomically. Global retention associates the current
promotion evidence, not automatically the old Project Section's historical sources.
Disclosure, writable scopes, current-project registration, authorized target/section
handles, path and content safety, complete-snapshot CAS, lease fencing and recovery
continue to gate writes; cross-project A→B writes remain forbidden.

Legacy relay/import triggers: 6 delivered expressions, 16 KiB, 120-second idle debounce, 10-minute
oldest backlog, lifecycle flush, or explicit flush. Session caches instead seal after exactly ten
settled interactions, or an actual exit tail; scheduler settings cannot override ten. Empty queues do not call models.
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
npm ci
node scripts/verify.mjs
# 修改包导出/消费方式时，构建后追加：
npm run test:consumer # 真实 tarball 隔离安装，需要 npm registry；不调用真实模型
npm pack --dry-run
# 隔离数据目录 + 合成维护模型：Init 与 Markdown 导入 → 本地文件 → 读取 演示（不证明真实模型语义）：
npm run build && node scripts/demo-init-synthetic.mjs [--home <new-or-empty-dir>] [--markdown notes.md]
# 构建后验证 smoke 自身的 Responses / Chat 流程（本地 fake Provider，无需 Key）：
npm run test:provider-smoke
# 真实 Provider：使用现有格式的配置副本，仅复制 remote；Key 来自进程环境：
node scripts/smoke-provider.mjs --config /path/to/provider-config.json --live
```

The provider smoke requires an explicit `remote.proxy` mode, uses fresh temporary
storage, and checks source-linked durable receipts plus restarted reads. A processed
`ignore` does not pass retention. See [the procedure and evidence levels](provider-verification.md)
for network conditions, reports, and the retained DeepSeek entry point.

The demo only writes into a fresh directory (a new temp directory by default); it refuses
a non-empty `--home` and never deletes or overwrites an existing configuration, `.env` or
data directory. It prints the Codex/Pi/`show`/`mcp-config` invocations for its data
directory. Real ChatGPT desktop, Codex CLI and Pi sessions are recorded separately in
`docs/init-v0.1-verification.md`, which distinguishes synthetic tests, real client
protocol/host integration, and the real end-to-end loop.

### Reading limitations

Reads are lock-free file reads of atomically published Markdown; a crash between
staging and publication is repaired by the next Writer start, so a read-only process
can briefly see the previous published state. Reads never migrate, repair or create
canonical files. Consumers receive whole documents; only the Writer bounds their size.
The `instructions`/description text asks consumers to use memory for questions about
the user; whether a given client model actually calls `memory_read` for a given
question is client behaviour, not something this server can enforce.

Tests use scripted model responses to prove protocol, capture, scheduling and commit
behavior; they do not prove that a real model will classify scope correctly or avoid
misusing maintain for state changes. Those semantic judgments remain the model's
responsibility; the executor does not use text-comparison heuristics to infer them. Real-provider evaluation
requires explicit credentials and budget and is not run automatically. Transformed
inputs are conservatively quarantined; session assistant/tool context requires
independent `conversation_context` disclosure permission. No old user data directory is cleaned.

### Capture trust boundary

Pi does not expose an end-to-end original-input token. Common Memory validates the
input event it receives; an earlier extension can transform text before that event
reaches this extension, which is not distinguishable through the public API. Place
Common Memory before input-transforming extensions and treat earlier extensions as
trusted host components. Transformations after its capture (including built-in prompt
templates), mixed queued authorities/scopes and ambiguous candidates are isolated.
This is conservative host-event provenance, not proof against a malicious extension.
Mixed/image input is quarantined with complete text and an unsupported-content marker;
image blobs are not collected. Session assistant/tool and prior-turn context is
marked context_only and never authorizes a write. The default context tail is two
same-session/scope turns, resolved by reference; forget/prune clears related context.

Manual edits to a document invalidate its title-based source links. On the next
committed maintenance, its stale links and associated processed observation bodies
are conservatively cleared in the recoverable receipt; current Markdown and other
documents are not deleted. This avoids retaining orphan evidence after a manual
rename followed by forget, at the cost of that document's short-term evidence buffer.
Advanced library configuration exposes `documentSoftBytes`, `documentHardBytes`,
`retentionMs`, `deadlineMs` and `maxRequestBytes` on Writer. Pi compatibility is pinned
to 0.84.4, whose callback/queue ordering was inspected for this implementation.
