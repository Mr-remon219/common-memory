# Security and privacy

Common Memory is a local, single-user memory store, not a multi-tenant service or an
authentication boundary. Processes that share a dataRoot must belong to the same
trusted user and use one configuration authority and compatible software versions.

## Reporting a vulnerability

Do not put API keys, proxy credentials, personal Markdown, SQLite databases or raw
conversations in public issues. Use GitHub's **Report a vulnerability** option if it
is enabled for this repository. Otherwise contact the maintainer through the
[repository](https://github.com/Mr-remon219/common-memory) to arrange a private channel;
a public request for a contact channel must not include exploit details or private data.
No response-time guarantee or independently audited security certification is claimed.

Include the package version, Node version, operating environment (including WSL),
entry point and a minimal synthetic reproduction. A controlled error code and redacted
configuration are preferable to a database dump. Report packaging/dependency issues
as well as scope bypasses, unauthorized writes, secret disclosure and recovery failures.

## Data boundaries

- Canonical Markdown is local plaintext. SQLite also holds pending user expressions,
  session context and recovery/source-link metadata. These are not encrypted by this
  package. Protect the OS account, filesystem and backups accordingly.
- Authorized material is sent to the configured model provider. Local storage does
  **not** mean offline processing. The provider's retention and privacy policies apply.
  Review scope and provenance permissions before enabling capture or import.
- Assistant/tool context and imported material have independent provenance. Imports
  are not authenticated user statements and cannot alone authorize forgetting
  user-derived content. Model-based semantic judgments remain fallible.
- Secret scanning reduces accidental disclosure; it cannot detect every secret or
  replace reviewing what you disclose. Do not intentionally place credentials in
  memory. The packaged maintainer is instruction text; memory/import text is data.
- MCP is stdio only. Client IDs namespace local submissions; they do not authenticate
  the host. Enable relay only for trusted hosts that faithfully relay user turns.
- Disabling permissions is not hot revocation. Restart active clients after changes.
  It does not retract requests already sent to a provider.
- Forget removes current retained state and associated eligible local evidence, not
  host transcripts, external backups, provider records or bytes on underlying media.

## Maintenance and support

The 0.2.x release is early-access software. There is no promise of backports to
historical versions or compatibility with untested host versions. Review the current
[release/support boundaries](docs/releasing.md), [session integration](docs/session-integration.md)
and [README](README.md). Keep a complete offline backup before upgrading; runtime
SQLite is durable state, not a disposable index.
