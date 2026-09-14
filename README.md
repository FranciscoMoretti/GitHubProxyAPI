# GHPA

Keep the official `gh` CLI. Route eligible repository reads across GitHub App installations, while preserving your identity for writes and user-dependent requests.

The npm package is `@franciscomoretti/ghpa` and its primary command is `ghpa`.
The longer `githubproxyapi` command remains available as an equivalent
compatibility alias.

A local TypeScript/Node.js daemon receives HTTP over a private Unix socket. `gh` still owns its commands, options, formatting, pagination, authentication and interactive behavior. No CLI command implementation is copied.

## What works

- Personal credentials pass through unchanged by default. Only explicitly enrolled credentials can use the App pool.
- Multiple independent App installations with scoped tokens, automatic renewal and coordinated refresh.
- Selection based on available quota and reset time, with separate REST/search/GraphQL buckets.
- At most one retry of an approved read after explicit primary exhaustion. Writes and uncertain failures are never replayed.
- Shared backoff for secondary throttling, including compressed GraphQL error responses with HTTP 200.
- Live caller repository/capability checks before App substitution; short-lived authorization evidence, stable repository IDs and exact request allowlists.
- Streaming uploads/downloads, unchanged redirect/pagination headers, cancellation and bounded concurrency.
- Background start/stop, scoped execution, status, diagnostics and reversible persistent `gh` setup.

This is a single-user macOS/Linux app, requiring **Node.js 22+** and an installed `gh`. Offline integration tests run the real `gh` executable against fake upstreams. Live App response equivalence and your actual capacity gains must be checked on your repositories; they are not guaranteed by the tests.

## Install from source

```sh
npm ci
npm run check
npm link

ghpa init
ghpa start
ghpa exec -- gh api user --jq .login
ghpa status
ghpa rate-limit
```

Or install the published command globally:

```sh
npm install --global @franciscomoretti/ghpa
```

You can use `node dist/cli.js` instead of installing the command with `npm link`. `serve` runs in the foreground; `start` detaches a background process and writes a private log beside the config. It does not register a login service. Run `start` after reboot.

With no Apps configured, the proxy is a personal pass-through and quota monitor. No global `gh` settings change until you explicitly run `enable-gh`.

## Add GitHub Apps

Create or reuse GitHub Apps installed on your chosen repositories. Their **installation tokens** provide separate quotas; more personal tokens for the same account do not. Registering apps or adding tokens does not grant them your private organization access. [GitHub authentication and limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

Keep downloaded private keys outside this repository with file mode `600`. Start with read permissions for Contents and/or Pull requests and Issues. The daemon requests only the configured read permissions and repository IDs when minting a token.

```sh
# Discover installation IDs without displaying secrets.
ghpa apps discover --app-id 12345 --key-file /absolute/path/app.pem

# Obtain the stable repository ID using your normal user identity.
gh api repos/OWNER/REPO --jq .id

# Replace all example IDs and paths with your values.
ghpa apps add --name reader-a \
  --app-id 12345 --installation-id 67890 \
  --key-file /absolute/path/app.pem \
  --repo OWNER/REPO:123456 \
  --permission contents --permission pull_requests --permission issues

# Repeat apps add with a different App installation for another quota.
ghpa enroll-caller
ghpa stop
ghpa start
ghpa doctor
```

`enroll-caller` obtains the current `github.com` token using `gh auth token` and stores only its SHA-256 fingerprint. It never prints or stores the token itself. For another token, pipe it to `enroll-caller --token-stdin`. Rotating credentials or switching accounts requires enrollment again before App offloading can resume. Requests with unenrolled credentials remain personal.

GitHub CLI exposes its own quota through the API endpoint `gh api rate_limit`;
it has no dedicated rate-limit command. `ghpa rate-limit` presents the latest
rate-limit headers observed for the personal
`gh` credential and each App installation. It labels the personal route as the
write identity and every configured App as read-only, including its configured
permissions. Use `ghpa rate-limit --json` for scripts. `ghpa quotas` is an
equivalent alias. A quota remains `unknown`
until that credential has produced a GitHub response in the current or restored
daemon state.

Configuration defaults to `~/.config/githubproxyapi/config.json`; set `GITHUBPROXYAPI_CONFIG` for another absolute path. Configuration changes take effect on restart. `apps list` and `config validate` inspect configuration without calling GitHub.

## Use your existing gh

Try scoped execution first:

```sh
ghpa exec -- gh api repos/OWNER/REPO/pulls/123/files
```

The runner copies your gh configuration into a private temporary directory, overlays the socket setting, forwards the arguments and preserves the child exit status. This isolates configuration files, not OS keyring operations: authentication commands can still change shared credentials.

For persistent use:

```sh
ghpa enable-gh
gh api repos/OWNER/REPO/pulls/123/files
gh pr view 123 --repo OWNER/REPO
ghpa status

# Restore your previous socket setting before stopping the daemon.
ghpa disable-gh
ghpa stop
```

Enabling preserves the previous socket setting and unrelated YAML fields/comments. Disabling refuses to overwrite a socket setting you changed afterward. If the daemon is unavailable, run `disable-gh`; unchanged `gh` does not automatically bypass a failed socket. Git clone/fetch/push subprocesses and extensions with independent HTTP clients do not use this proxy transport.

## Which reads use Apps?

| Request | Routing |
| --- | --- |
| GET Git blob by full SHA | App candidate; Contents read |
| GET Git tree by full SHA, optional `recursive=1` | App candidate; Contents read |
| GET PR files, optional numeric `page`/`per_page` | App candidate; Pull requests read |
| Simple GraphQL `repository { pullRequest(number: ...) { scalar fields } }` | App candidate; Pull requests read |
| Simple GraphQL `repository { issue(number: ...) { scalar fields } }` | App candidate; Issues read |
| Writes, repository metadata, viewer fields, search, connections, unknown fields/arguments | Personal |
| Conditional requests, ranges, unfamiliar API versions/media types | Personal |

GraphQL supports validated aliases, variables, defaults and fragments within a deliberately small schema. It never splits or rewrites operations. A supported scalar query example:

```sh
ghpa exec -- gh api graphql \
  -f query='query { repository(owner:"OWNER", name:"REPO") { pullRequest(number:123) { number title state additions deletions } } }'
```

Default `gh pr list/view/checks` queries may include unsupported connections or viewer-related fields and remain personal. A successful proxied command does not mean its quota was offloaded. Inspect `routes` and `reasons` in `status`; the proxy does not claim compatibility with arbitrary GraphQL identity changes. Extend the request allowlist with tests as actual workloads justify it.

Before substitution, the caller must pass repository-ID and permission-specific read checks. Evidence is cached for at most 60 seconds (`accessTtlMs`), so revocation detection has a bounded delay. Probe requests consume some personal quota; `counts.validationRequests` reports that overhead. An App must also return a scoped token covering that repository and permission. A failed App is temporarily quarantined; it cannot turn a missing caller permission into App access.

## Boundaries and diagnostics

- No response cache, arbitrary GraphQL rewriting, public hosted gateway or Windows socket support in this release.
- Approved HTTPS origins: `api.github.com`, `github.com`, `uploads.github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`, `github-releases.githubusercontent.com`. Other destinations return an actionable error; use direct gh for unsupported Enterprise/custom origins. Download destinations receive no injected credentials.
- Websocket/CONNECT traffic is unsupported. Redirects remain the client's responsibility.
- Rate/cooldown state is saved privately on shutdown and periodically; App tokens remain in memory. One daemon owns a socket. An existing live socket or unrelated file is never removed.
- `maxConcurrency` defaults to 8, `requestTimeoutMs` to 30000; increase the timeout for large downloads (maximum 300000). Queues and GraphQL inspection are bounded. Bodies exceeding the inspection bound pass through personally.
- Status shows aliases, counts, routing reasons and budgets, not raw tokens, keys or response contents. No raw traffic logging is enabled. Read headers for actual GitHub capacity; status is not an account-wide usage meter.

## Development and tests

```sh
npm run typecheck
npm test
npm run build
node dist/cli.js --help
```

Tests use generated RSA keys, fake clocks and local upstreams. The `gh` integration test is skipped only when `gh` is absent. Test coverage includes token signature/refresh/scope, scheduler concurrency and reset handling, conservative policy, App failover, identity preservation, shared throttling, gzip, streaming, timeouts, socket ownership, background lifecycle and precise config restoration. CI runs the same checks without real credentials.

Architecture: [implementation plan](docs/implementation-plan.md). Evaluation: [upstream assessment](docs/proxy-value-notes.md).
Live setup evidence: [validation report](docs/live-validation.md).
Naming decision: [command-name research](docs/name-research.md).

## Upstream credit

This is an independent TypeScript implementation informed by [bored-engineer/github-api-proxy](https://github.com/bored-engineer/github-api-proxy), its [rate-limit transport](https://github.com/bored-engineer/github-rate-limit-http-transport) and [App authentication helper](https://github.com/bored-engineer/github-auth-http-transport). We reuse their ideas for credential pools, Unix listeners, installation token sources, and quota/reset-based selection; source comments link the relevant solutions. We add caller eligibility, conservative semantic routing, preserved personal writes and reversible gh integration.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for pinned references, attribution and license notices. Licensed under [MIT](LICENSE).
