# Official `gh` transport integration research

Checked 2026-09-12 against `cli/cli` **v2.100.0**, which pins `cli/go-gh/v2` **v2.16.0**. This is a source review and proposed test plan; live-account compatibility is not established by it. [Dependency pin](https://github.com/cli/cli/blob/v2.100.0/go.mod#L19)

## Recommended integration

Retain the official executable and route its HTTP transport through a local Unix socket. No command/flag parser, output renderer, pagination engine, or interactive UI needs to be copied. Start with isolated test configuration; enable the existing user's `gh` configuration only after compatibility tests pass. This is an implementation proposal based on the transport findings below.

The daemon must be an HTTP server on the Unix socket, forwarding approved origins to HTTPS upstreams. It is more than a reverse proxy hardwired to `api.github.com`: some `gh` operations reach OAuth, uploads, archives, and download hosts through the same transport.

## Verified behavior

| Area | Source finding | Consequence |
| --- | --- | --- |
| Socket setting | `resolveOptions` reads `cfg.Get([]string{"http_unix_socket"})` at the configuration root. There is no host lookup in the actual transport path. | Set the global key; do not rely on `gh config set -h github.com http_unix_socket ...` to isolate github.com. [Options source](https://github.com/cli/go-gh/blob/v2.16.0/pkg/api/client_options.go#L110) |
| Local protocol | Both `Dial` and `DialTLS` return `net.Dial("unix", socketPath)`; keepalives are disabled. | The connection to the daemon is raw HTTP even for an HTTPS request URL. A normal Unix HTTP listener suffices; no interception certificate is needed. The daemon establishes upstream TLS. [Socket transport](https://github.com/cli/go-gh/blob/v2.16.0/pkg/api/http_client.go#L222) |
| Host coverage | The dialer ignores the requested network/address. `NewHTTPClient` substitutes it below request/auth middleware. A supplied custom transport takes precedence. | This setting affects every origin reached through that client, not just API calls. Independently constructed/custom clients may bypass it. [HTTP construction](https://github.com/cli/go-gh/blob/v2.16.0/pkg/api/http_client.go#L49) |
| CLI client factories | Authenticated, plain, and external factory clients all construct go-gh clients. The external factory supplies no custom transport by default. | Plain/external does not mean bypassing the socket. Preserve requests' authentication state; do not add an app token just because traffic traverses the daemon. [Factories](https://github.com/cli/cli/blob/v2.100.0/pkg/cmd/factory/default.go#L180), [CLI clients](https://github.com/cli/cli/blob/v2.100.0/api/http_client.go#L32) |
| Personal token | The CLI resolves its active token for each request and preserves an already supplied Authorization header. Cross-host redirects do not acquire the original host's token. | The incoming credential can be retained for personal/pass-through operations; do not require copying a PAT into daemon config. Preserve explicitly supplied credentials and cross-origin redirect rules. [Auth middleware](https://github.com/cli/cli/blob/v2.100.0/api/http_client.go#L142) |
| REST and GraphQL | `gh api` constructs both REST and GraphQL requests with the same HTTP client. Absolute URLs are sent unchanged. | Both protocols can reach the socket, including explicit URLs. Classification must inspect GraphQL operations, not equate HTTP POST with a mutation. [gh api request code](https://github.com/cli/cli/blob/v2.100.0/pkg/cmd/api/http.go#L14) |

**Protocol limitation:** the original scheme is not reliably recoverable from an ordinary origin-form HTTP request received on this socket: both HTTP and HTTPS request URLs use the same connection mechanism. Forward recognized GitHub origins using explicit HTTPS origin mappings. Treat arbitrary `gh api http://...` targets as an explicit compatibility limitation or require a configured mapping/bypass; do not silently infer general-purpose origin semantics. This is an inference from the socket transport, to confirm in the local probe.

## Paths that need separate compatibility coverage

- **Authentication:** `gh auth login` supplies its plain client to `authflow.AuthFlow`; the OAuth library is given that client. Therefore OAuth HTTP and login validation can traverse the socket. The external browser and localhost browser callback are separate. OAuth exchanges and `viewer`/current-user validation must retain normal identity. [Login wiring](https://github.com/cli/cli/blob/v2.100.0/pkg/cmd/auth/login/login.go#L177), [Auth flow](https://github.com/cli/cli/blob/v2.100.0/internal/authflow/flow.go#L27), [Login validation](https://github.com/cli/cli/blob/v2.100.0/pkg/cmd/auth/shared/login_flow.go#L232)
- **Git:** clone/fetch/push use a Git subprocess, potentially with `gh auth git-credential` as credential helper. Changing the HTTP socket does not route Git's network transport. Preserve the real user credential rather than substituting a proxy-only placeholder for everyday use. [Git subprocess and credential helper](https://github.com/cli/cli/blob/v2.100.0/git/client.go#L73)
- **Extensions:** the extension manager launches external executables and inherits the environment. An extension that calls `gh` or honors go-gh's socket setting may participate; one with its own HTTP stack may bypass it. Test installed extensions individually rather than promising universal coverage. [Extension dispatch](https://github.com/cli/cli/blob/v2.100.0/pkg/cmd/extension/manager.go#L86)
- **Release uploads:** API-supplied absolute upload URLs are used directly with the supplied HTTP client. Bodies are streamed, with Content-Length and `GetBody`; `gh` already retries certain errors. Preserve original identity and avoid adding another mutation retry loop. [Upload code](https://github.com/cli/cli/blob/v2.100.0/pkg/cmd/release/shared/upload.go#L134)
- **Release downloads and archives:** API asset URLs, byte streams, and redirects use the supplied client. Archive downloads deliberately rewrite a codeload redirect path. Return redirects to `gh` rather than following them inside the proxy, so the CLI retains its behavior. [Download code](https://github.com/cli/cli/blob/v2.100.0/pkg/cmd/release/download/download.go#L279)
- **Other clients and protocols:** Codespaces tunnels, SSH, websocket traffic, external browsers, and specialty clients are not covered by this source audit. Inventory them if they appear in the user's workload; do not count their traffic as pooled capacity.

For forwarding, retain a narrow app-routing surface (`api.github.com` plus proven operations). Other supported origins pass through using their original authentication semantics. Maintain an explicit destination policy; app tokens must never be injected into downloads, OAuth, arbitrary URLs, or a different GitHub host. Unknown-origin behavior must be documented rather than accidentally turning the daemon into an unrestricted authenticated forward proxy. These are design recommendations.

## Why `api_host` is a secondary option

`api_host` is experimental and per-host only. It permits a bare hostname, **without scheme or port**, and does not rewrite absolute URLs. It therefore is not a simple `http://localhost:8080` base URL. The hostname needs an appropriate HTTPS endpoint; canonical-host requests can still be authenticated and sent separately. [CLI setting](https://github.com/cli/cli/blob/v2.100.0/internal/config/config.go#L606), [Validation and URL contract](https://github.com/cli/go-gh/blob/v2.16.0/pkg/api/client_options.go#L14)

This can be useful for a hosted gateway, but uploads/download URLs, pagination links, and caller-provided absolute URLs require separate handling. The CLI's common API client explicitly documents that absolute URLs do not undergo host-level resolution. [API client](https://github.com/cli/cli/blob/v2.100.0/api/client.go#L196)

## Isolated rollout and rollback proposal

1. **Offline transport proof:** create a temporary `GH_CONFIG_DIR` containing only `http_unix_socket`. Use a dummy `GH_TOKEN`, isolated `XDG_CACHE_HOME`, `XDG_STATE_HOME`, and `XDG_DATA_HOME`, disabled telemetry/update notices, and mock responses. Execute the actual installed `gh`. Never log or load a real credential during this stage.
2. **Personal pass-through proof:** opt in only selected commands using a separate configuration directory and process environment. Preserve required personal aliases/preferences in this test config. Keep tokens in process memory or normal credential storage, not in fixtures. Compare output and exit status with direct `gh`.
3. **App routing proof:** exercise a disposable repository accessible to each installation, beginning with proven repository reads. Retain pass-through for every unclassified operation.
4. **Everyday integration:** once tests pass, `enable` records whether the user's global socket key exists and its exact value, then edits only that setting. `disable` restores that key without replacing unrelated config or touching account authentication. An isolated `run -- gh ...` mode remains useful for diagnostics.
5. **Failure/rollback:** a stopped daemon causes socket-based requests to fail; `gh` has no automatic fallback in the inspected dialer. Provide an immediate disable command and a managed background service. Do not replay whole CLI commands on failure, because some may already have written data.

`GH_CONFIG_DIR` controls YAML configuration, while cache/state/data each use their respective XDG paths. It is **not** a complete sandbox: Keychain service identifiers are `gh:<hostname>` independently of config directory. Avoid `gh auth login/logout/switch` in isolated tests against the real account. [Configuration paths](https://github.com/cli/go-gh/blob/v2.16.0/pkg/config/config.go#L231), [Keyring identity](https://github.com/cli/cli/blob/v2.100.0/internal/config/config.go#L529), [Environment options](https://cli.github.com/manual/gh_help_environment)

## Test matrix and acceptance criteria

These are proposed tests, not completed results.

| Layer | Cases | Required evidence |
| --- | --- | --- |
| Socket protocol | REST GET; GraphQL POST; absolute API URL; global vs host-only config; missing socket | Actual `gh` reaches plaintext Unix server with expected host/path/body; host-only setting is not mistaken for active routing; failure is actionable. |
| CLI compatibility | `gh api --paginate --slurp`, custom headers, JSON input, `--jq`, `--template`; representative repo/issue/PR/run commands | Match direct output, status codes, stderr/exit behavior, stdin and pagination semantics on stable fixtures. |
| GraphQL | Repository query, aliases/fragments/variables, mixed repository/viewer fields, mutation, unknown operation | Only proven equivalent queries use apps; viewer-sensitive and unknown operations preserve user identity. |
| Downloads | Redirect to asset host; tarball/zipball codeload; binary/large body; range request and cancellation | Bytes and headers match, CLI redirect processing survives, no app credential leaks, streaming does not buffer entire file. |
| Uploads/writes | Mock release upload; POST/PATCH/DELETE; interrupted upstream after request body sent | Body/Content-Length preserved; actor unchanged; proxy introduces no ambiguous replay. Live writes only in an explicitly chosen disposable fixture. |
| Origin boundaries | Auth endpoints, non-API GitHub host, foreign absolute URL, configured enterprise host, redirect across hosts | Explicit destination policy, correct credentials, no app injection outside eligible API origin, supported behavior documented. |
| Surrounding CLI | Alias/preferences, shell completion, `gh auth status`, Git clone/fetch credential helper, selected extensions | Existing functionality retained or specific non-pooled limitations recorded. |
| Lifecycle | Enable twice, prior custom socket value, config edited after enable, daemon restart, disable | Idempotent setup; precise restoration; no token/config loss; no hanging commands. |
| Upstream updates | Installed baseline and each proposed `gh` upgrade | Contract suite must pass before widening the supported-version claim. |

Capacity acceptance belongs in the routing tests: identify selected credential and rate bucket in redacted diagnostics; verify distinct installations' budgets with a handful of read requests; simulate exhaustion and secondary throttling locally. Do not exhaust the user's real quota to prove failover.
