# Existing projects for GitHubProxyAPI

Research date: 2026-09-12.

## Finding

The core idea already exists. The closest match is [bored-engineer/github-api-proxy](https://github.com/bored-engineer/github-api-proxy): a Go reverse proxy mixing personal tokens and GitHub App installations, with round-robin balancing and a Unix-socket listener. It is a strong candidate for extension. This research did not establish an existing complete solution that combines permission-aware quota selection, preserved personal identity, and fully verified unchanged `gh` behavior.

This is source/documentation research, not an installation, security audit, or runtime compatibility test. Search cannot prove that no other matching project exists.

## Search coverage

Used web searches restricted to GitHub and direct GitHub repository search, including `github-api-proxy`, `github api proxy multiple tokens`, `github token pool`, `github proxy rate limit`, `github app proxy`, and `http_unix_socket`. Read primary documentation for twelve relevant projects and inspected the closest candidate's routing and authentication source. Excluded Copilot/LLM gateways, download mirrors, CORS-only examples, and this repository itself. Some web code fetches failed; the GitHub API provided the closest candidate's current code successfully.

## Closest match: bored-engineer/github-api-proxy

Inspected commit [`4081191d93a09128278fa8f9e96cb42737f45bfe`](https://github.com/bored-engineer/github-api-proxy/commit/4081191d93a09128278fa8f9e96cb42737f45bfe), dated 2026-08-03. Repository metadata reported MIT, not archived, and one star at the time of checking. Small adoption is not a quality verdict, but it does not establish production maturity.

Verified in [main.go](https://github.com/bored-engineer/github-api-proxy/blob/4081191d93a09128278fa8f9e96cb42737f45bfe/main.go):

- Repeated `--auth-token`, `--auth-app`, and `--auth-oauth` arguments build a common pool of authentication transports.
- Each App entry includes client/App identifier, installation ID, and private key reference; the App token source is passed to an OAuth2 transport.
- `--listen unix:/path/to/socket` is implemented, alongside TCP listeners. This provides the transport primitive needed for `gh config set http_unix_socket`; end-to-end gh compatibility remains untested.
- Rate tracking, capacity reservation, synthetic exhausted-budget responses, conditional caching and Prometheus metrics are integrated.
- Generic request forwarding includes the `/graphql` path, and GraphQL is a configured metrics resource. This is not evidence of GraphQL operation/identity analysis.

The underlying [App authentication helper](https://github.com/bored-engineer/github-auth-http-transport/blob/main/app.go) loads an RSA key and obtains an installation token source from `int128/oauth2-github-app`. There is an installation authentication lifecycle, rather than only accepting a manually generated expiring token.

Critical gaps shown by the inspected implementation:

1. [RoundRobinTransport](https://github.com/bored-engineer/github-api-proxy/blob/4081191d93a09128278fa8f9e96cb42737f45bfe/srcip.go) simply increments an index and invokes that credential. It does not choose by remaining quota, repository access, or permissions. An exhausted selection can produce a synthetic error even while another credential has capacity.
2. The same pool is used for methods and endpoints generally. No personal-identity pinning for writes or identity-sensitive reads appears in the request routing; a write may be attributed to an App.
3. All proxied hosts are rewritten to one upstream API base. Upload hosts, redirected downloads, authentication flows, pagination and mixed REST/GraphQL gh commands need compatibility testing.
4. It exposes `/api/v3/` adaptation, but no explicit `/api/graphql` alias appears in the inspected router. Retaining canonical github.com context with the Unix socket avoids relying on enterprise-shaped paths, but still needs testing.

Recommendation: evaluate extending this project before creating a new proxy core. The remaining work should focus on request eligibility, quota-aware selection, identity preservation, and a validated gh setup flow.

## Other close projects

Checked 2026-09-12. These are primary repository documentation findings, not runtime validation. Source-file retrieval was unavailable for several projects; absence below means not documented in the material inspected, not a proven absence from all code.

| Project | What overlaps | Gap against our proposed design |
| --- | --- | --- |
| [openabdev/octobroker](https://github.com/openabdev/octobroker) (formerly ghpool) | PAT pool chooses remaining budget for REST/GraphQL reads; caches reads; GraphQL mutations retain caller auth. App credentials and multiple installations supported for MCP. | The sample config assigns each App installation a unique owner, rather than balancing multiple apps for one owner. REST/GraphQL retain the PAT pool. `obk` is a command-aware shim that handles reads and delegates writes to real `gh`. |
| [gittrends-app/github-proxy-server](https://github.com/gittrends-app/github-proxy-server) | REST/GraphQL token pooling, load balancing, rate limiting, base-URL-compatible API. | Takes static token values/files. README explicitly targets collecting public data and says it is not suitable for private user/repository information. No App mint/refresh lifecycle or native `gh` integration documented. |
| [hackclub/gh-proxy](https://github.com/hackclub/gh-proxy) | Go/Postgres REST/GraphQL proxy; donated-token rotation per core/search/code_search/graphql bucket; caching and admin UI. | Tokens obtained through OAuth donation flow. `/gh/` route prefix and `X-API-Key` authentication. No App-installation pool or native `gh` setup documented. |
| [denysvitali/gh-proxy](https://github.com/denysvitali/gh-proxy) | Go proxy brokering installation credentials, with repository/endpoint policy, Git transport and REST capabilities. | Documents one App ID/private key, tenant-to-installation mapping and consumer-to-tenant pinning. This is access brokerage rather than quota balancing across apps. No GraphQL or native `gh` integration established. |
| [link-assistant/router](https://github.com/link-assistant/router#github-api-credential-proxy) | GitHub REST/GraphQL/git proxy and explicit native `gh` integration through `http_unix_socket`; no duplicated command implementation needed. | Its GitHub proxy configuration documents one upstream credential (`GITHUB_PROXY_TOKEN` or file), injected for all clients. Multi-provider AI routing is separate and does not establish multi-App GitHub quota pooling. |

## Useful details

Octobroker's [sample configuration](https://github.com/openabdev/octobroker/blob/main/config.example.toml) is particularly informative: `[[mcp.github_apps]]` uses `owner` as a unique routing key; calls route by repository owner. Comments explicitly state that the PAT pool remains for REST/GraphQL. This is multi-installation routing across owners, not pooling interchangeable installations on one account. The configuration was inspected directly; the Rust implementation was not successfully fetched.

Octobroker's README also claims `GITHUB_API_URL` redirects `gh api` and proposes its own `obk` shim for built-in commands. Treat the environment-variable claim as unverified; do not rely on it without checking upstream `gh`. Its documented shim approach differs from our requirement to preserve all upstream commands and options without reimplementing them. [Client documentation](https://github.com/openabdev/octobroker#how-clients-use-it)

Router's documented adapter uses `LISTEN_UNIX_SOCKET`, `gh config set http_unix_socket`, `GH_HOST` and `GH_ENTERPRISE_TOKEN`. It maps the CLI's enterprise-shaped REST/GraphQL paths to the GitHub proxy. This is a useful reference for the transparent transport layer, not evidence of quota pooling. [GitHub CLI integration](https://github.com/link-assistant/router#github-cli)

No project in this subset was verified to provide all three together: multiple interchangeable GitHub App installation quotas on one account, personal-token identity-aware fallback, and an unchanged official `gh` client. The closest overall candidate is assessed above.

## Additional candidates screened

| Project | Findings from primary documentation | Fit |
| --- | --- | --- |
| [pleaseai/local-hub](https://github.com/pleaseai/local-hub) | Rust HTTP/Unix-socket proxy, explicit unchanged `gh` setup, GET TTL/ETag caching, caller-token cache isolation and write passthrough. | Strong reference for the local daemon experience; no App quota pool documented. |
| [brunoborges/ghx](https://github.com/brunoborges/ghx) | Invokes real gh, caches an allowlist of read commands, coalesces concurrent calls, passes mutations through, starts its daemon automatically. | Closely matches the CLI experience and may reduce repeated-call pressure; not an installation quota pool. Command-aware caching still needs an allowlist. |
| [xu-xiang/GithubGather](https://github.com/xu-xiang/GithubGather) | Multiple static tokens and rotation, pagination, filtering and linked data requests. | Primarily a data harvester; no App token lifecycle or native gh integration established. |
| [janpreet/kado-proxy](https://github.com/janpreet/kado-proxy) | PAT passthrough or App JWT/token exchange configured with one App and installation. | Authentication proxy; no multi-App balancing documented. |
| [Lttac/gh-proxy-sentry](https://github.com/Lttac/gh-proxy-sentry) | Caching, request coalescing, budget guards, circuit breaker, dashboard. | Targets redundant calls and bandwidth; no App-installation quota pooling established. |
| [buildkite/github-api-proxy](https://github.com/buildkite/github-api-proxy) | Experimental job-OIDC credential broker using attenuated installation tokens; current README identifies one implemented read endpoint. | CI access control prototype, not a general-purpose quota pool. |

Also followed the historical [Kubernetes ghProxy pointer](https://github.com/kubernetes/test-infra/tree/master/ghproxy) to [Prow's ghproxy](https://github.com/kubernetes-sigs/prow/tree/main/cmd/ghproxy); not assessed as a multi-App candidate here.

## Decision

- For PAT plus multiple installation credentials: begin evaluation with bored-engineer/github-api-proxy.
- For unchanged gh plus a lightweight local caching daemon: inspect pleaseai/local-hub.
- For command-level caching while reusing official gh: inspect brunoborges/ghx.
- For PAT pooling and identity-preserving mutations: inspect octobroker, recognizing that its App MCP routing is a different path.

No tools were installed, no GitHub credentials were added, and no global gh configuration was changed. Only this research note was written.
