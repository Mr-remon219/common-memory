# Common Memory outbound network — research and reviewed design

2026-09-08. Node 24.20.0 (bundled Undici 7.29.0); independently installed and inspected **Undici 8.10.2**. Existing Init changes are retained. Network ownership applies uniformly to CLI, MCP and Pi, not host-specific launch patches.

## Evidence and decisions

Primary sources: [Node 24 util.parseEnv](https://github.com/nodejs/node/blob/v24.20.0/doc/api/util.md#utilparseenvcontent), [Node TLS CA APIs](https://github.com/nodejs/node/blob/v24.20.0/doc/api/tls.md#tlsgetcacertificatestype), [Undici env agent](https://github.com/nodejs/undici/blob/main/docs/docs/api/EnvHttpProxyAgent.md), [ProxyAgent](https://github.com/nodejs/undici/blob/main/docs/docs/api/ProxyAgent.md), [SOCKS5](https://github.com/nodejs/undici/blob/main/docs/docs/api/Socks5ProxyAgent.md). The npm 8.10.2 package source was inspected directly; fetching its GitHub tag through the browser returned a cache miss. Do not substitute main-branch claims for the installed-version tests.

Local research scripts are in `/tmp/cm-network-research-58C9ty/`: `behavior.cjs`, `transport.cjs`, `connect-status.cjs`, `socks.cjs`. They use synthetic data/local servers, not personal Memory or real API keys.

| Tested native behavior | Product decision |
| --- | --- |
| EnvHttpProxyAgent does not read ALL_PROXY; HTTPS falls back to HTTP_PROXY | Own pure resolver implements HTTPS → HTTP → ALL and HTTP → ALL |
| Lowercase empty values mask uppercase values | Presence-based lowercase precedence, including explicit empty values |
| NO_PROXY is dynamically reread by native env agent | Freeze input and route when creating the model client; retries reuse it |
| example.com and .example.com match apex and subdomains, with label boundaries | Retain this explicitly tested semantic; `*.example.com` is the same suffix form |
| Native `localhost,*` and ` * ` do not act like a standalone `*` | Product treats any trimmed standalone `*` token as bypass-all |
| Expanded IPv6 does not match compressed IPv6 in the native agent | Normalize IP literals with WHATWG URL before comparing |
| Default and explicit :443 match HTTPS; other ports do not | Compare effective ports (HTTP 80 / HTTPS 443) |
| localhost does not match 127.0.0.1; CIDR is not implemented | No DNS lookup/loopback aliases; reject unsupported CIDR/glob syntax in an applicable bypass list |
| util.parseEnv preserves Windows backslashes without changing process.env | Local parsing for all new network modes; no process.loadEnvFile for new clients |
| Own Agent bypasses hostile global dispatcher; closing it leaves host dispatcher alive | Per-client owned Agent/ProxyAgent, never setGlobalDispatcher |
| Provider HTTP 401 is a response; HTTP proxy 407 is UND_ERR_INVALID_ARG; CONNECT 407 is deeper UND_ERR_ABORTED in fetch.cause | Bounded cause traversal, known code plus complete library-generated message format; persist only local enum/status |
| SOCKS5 returns HTTP 200 through a local proxy and sends target hostname to proxy; constructor emits ExperimentalWarning | Experimental SOCKS5 support, remote DNS; not formal cross-platform/real-proxy verification |

Earlier real DeepSeek probes showed default Node connecting then resetting while the same request via an explicit environment proxy completed in ~1.9 seconds. This establishes a route problem in that environment, not a rule that all users need proxies. Valid ignore and occasional invalid model JSON remain separate from transport success.

## Configuration and compatibility

Keep schemaVersion 2. Add exact-validated optional `remote.proxy`: `{mode:'direct'}`, `{mode:'env'}`, or `{mode:'custom',urlEnv:string,noProxy?:string}`. Add optional `remote.caFileEnv` only with an explicit proxy mode. New `defaultConfig()` writes `{mode:'env'}`. Reading and saving an old config preserves field absence; it means internal **legacy / host-managed / unknown**, never direct. Non-network settings must not migrate it. `config --network` is the explicit migration boundary.

Legacy borrows the old global fetch and preserves old private-env fill-if-undefined behavior, including existing HTTP_PROXY/NO_PROXY interactions with a host dispatcher. The legacy loader uses the same Node parser and excludes the newly reserved `COMMON_MEMORY_PROXY_URL` and `COMMON_MEMORY_CA_FILE`; these secrets must never be exported by a stale legacy instance. The network wizard persists only these reserved names. Other custom secret variable names are external-process-env-only. This is a deliberate legacy compatibility exception, not isolation for legacy hosts. Existing host implementations/Node flags remain authoritative; status cannot infer their actual route.

New modes parse private env locally. For standard proxy variables, choose the process source first for each case-insensitive semantic group, then private source; within a source a present lowercase key wins even when empty. Empty means cleared, not permission to recover a private/uppercase value. Custom bypass rules never inherit NO_PROXY. Custom proxy URI must be valid even when its explicit bypass matches; env mode validates only the selected proxy URI when it will be used. No applicable proxy means direct. No failed proxy fallback.

NO_PROXY accepts comma/whitespace-separated names, apex/domain suffixes, IPv4, IPv6 (brackets required for a port), optional ports, and standalone `*`. Normalize case, trailing dot, IDNA and IP spelling. Match suffixes only on domain-label boundaries; IPs exactly. Reject CIDR, URL/path syntax, malformed ports and other wildcard forms. Do not guess loopback aliases or WSL host addresses.

HTTP/HTTPS proxies are formal targets. SOCKS5 (`socks5:` / `socks:`) is experimental and uses remote DNS. SOCKS4, PAC/WPAD and integrated enterprise authentication are unsupported. CA input is a bounded PEM file, merged into a snapshot of Node's default trust store and applied only to the owned client. Certificate/hostname checks stay enabled.

## Ownership and failure handling

One small resolver, one owned network client, and local secret parsing; no routing framework. Resolved routes contain a private URL and a separate safe description. New modes use installed Undici fetch with an explicit owned dispatcher, reject redirects, and cannot escape to another origin. Legacy/injected fetch is borrowed and never closed.

MemoryModelPort stays analysis-only. Concrete remote models expose idempotent async close, abort their own requests and destroy only owned connections. The configured Writer owns its configured model; it blocks new work during close, aborts and awaits current work, closes SQLite after Writer cleanup, then closes its model. A plain Writer continues to borrow a model. CLI/MCP/Pi await cleanup, including construction failure and reload. No dispatcher switch within retries.

Network configuration, proxy authentication/availability, TLS validation, DNS, endpoint connection errors, provider API authentication, HTTP status errors and model-output failures have distinct controlled diagnostics. HTTP status from CONNECT is `proxyStatus`, not a provider `httpStatus`. First cancellation/deadline reason remains authoritative. Unknown errors remain unknown; do not infer proxy blame solely from configured mode. No raw exception, credentials, CA contents or provider body is persisted.

## Review and acceptance

Independent design review confirmed the legacy NO_PROXY compatibility trap, reserved-secret filtering, source-before-case precedence, async ownership cleanup, and bounded CONNECT error matching. Research and review preceded product changes.

Required regressions: old config round-trip/route preservation; reserved secrets not injected even by legacy loader; route matching matrix; per-instance/global isolation; HTTP/HTTPS proxy authentication and CA; experimental SOCKS5; cancellation and closure races; retries retain route; read-only MCP creates no network client. After implementation run the full Node 24 verify gate and built Linux consumer, then independent implementation review and necessary rechecks. Real smoke remains synthetic, isolated, fixed to deepseek-v4-flash-vision-exp/Responses/4096/60s with explicit reasoning none. Three independent runs must report every attempt and require real Writer receipts plus restarted key-free read for retention; never count ignore or adapter-only success as retained memory. Windows/macOS/WSL and desktop live results are reported separately.


## Implemented result and verification

The implementation follows this design. Exact-key optional fields stay in schemaVersion 2;
new defaults are env, while old field absence remains legacy. `no_proxy_invalid` is a
separate controlled configuration reason so unsupported lists are actionable. Legacy
reserved-name filtering is case-insensitive, including Windows aliases. Three concrete
review findings were fixed and independently rechecked: capture legacy fetch at creation,
do not blame the proxy for an endpoint reset after CONNECT, and always cancel/close Pi
resources even when requesting flush fails.

Final full verification: Node 24.20.0, Linux, **26 files / 341 tests**, typecheck, boundary
checks and clean build passed (`/tmp/cm-network-verify-final.log`). Built packed consumer
passed (`/tmp/cm-network-consumer-final.log`). Tests use local real HTTP/HTTPS/SOCKS5
servers for routing, 407 vs API 401, CONNECT, separate origin/proxy credentials, local CA
and both endpoint/proxy hostname verification, direct/global/two-instance isolation,
retry route retention, cancellation and cleanup. NO_PROXY semantics have their own
contract matrix. CA reads reject non-files and are bounded even if the file grows.

Three independent real DeepSeek Init + Markdown → actual Writer validation/commit →
durable receipts → restarted key-free MCP read runs passed. One needed Runtime retries
for a Core-rejected decision and invalid model JSON; two passed on first attempts.
[Safe machine-readable evidence](outbound-network-verification.json) and
[full Init acceptance history](init-v0.1-closeout.md) retain all results, including an
initial failed Markdown attempt. The old duplicate Rust fixture's lawful ignore is
separate from the new nonduplicate Fedora/fish retention fixture.

The real tests explicitly cleared both NO_PROXY spellings **inside isolated child env**.
The current host has unsupported CIDR entries, so its env configuration does not work
unchanged. This is an explicit remaining compatibility limit, not a successful test of
the original host environment. Choose a supported bypass list or custom network mode;
Common Memory never silently removes those rules or switches a failed proxy to direct.

| Environment / protocol | Evidence and limit |
| --- | --- |
| Node 24 on Linux, owned direct / env / custom HTTP(S) | Local real-server matrix and built consumer passed; selected DeepSeek env route passed live |
| Legacy host fetch / Node --use-env-proxy | Isolated child regression preserves old NO_PROXY loading and captured host fetch; route remains host-managed |
| SOCKS5 | Local remote-DNS and authentication tests passed; Undici marks it experimental; no real third-party SOCKS service tested |
| Windows / macOS native | Portable path handling and reserved-name casing covered by code/contracts; no OS execution or CI result claimed |
| WSL NAT / mirrored, GUI host env | [Microsoft networking documentation](https://learn.microsoft.com/en-us/windows/wsl/networking) informs explicit-address design; no live WSL or desktop-client acceptance |
| VPN / TUN | OS routing remains authoritative; not detected, changed or separately verified |
| CIDR, SOCKS4, PAC/WPAD, NTLM/Kerberos | Unsupported this round; no silent approximation |

OpenAI Responses has fake-contract preservation only; Qwen and GLM Chat are documentation
candidates without live calls; Hunyuan's exact json_object/model combination is unverified.
No brand-wide compatibility claim, package publication or personal configuration migration
was performed. Package remains 0.2.0/private:true.
