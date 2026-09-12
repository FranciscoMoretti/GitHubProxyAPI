# Value assessment: native gh with pooled GitHub Apps

Evaluated 2026-09-12. This note combines source inspection, workload economics and a local native-gh transport probe. The upstream proxy itself was not built or run; actual user traffic and live App parity were not measured.

## Recommendation

Worth a bounded extension if measured traffic is dominated by repeatable repository reads that the installations can access. Do not commit to a universal transparent GitHub identity replacement. The valuable product is preserving ordinary `gh` behavior while selectively moving eligible work to installation budgets. Request classification and conservative fallback are the substantive work; another command parser is unnecessary.

## Verified facts

- Official `gh` documents `http_unix_socket`, so integration below the CLI is supported. `api_host` is experimental. This establishes a transport hook, not proof that every command works through a particular proxy. [gh configuration](https://cli.github.com/manual/gh_config)
- Installation requests act as the app, require installation repository access and permissions, and are not supported by every REST endpoint. GraphQL access also depends on permissions; GitHub explicitly recommends testing the intended queries. Installation tokens expire hourly. Installing apps on a personal account does not confer the user's private organization access. [Installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- GraphQL and REST have separate primary quotas. Ordinary app installations start at 5,000 GraphQL points/hour, whereas user authentication—including App user tokens—draws from the user's budget. Secondary limits still apply, and a GraphQL limit can be reported in an HTTP 200 response. [GraphQL limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)
- Native CLI queries contain identity-sensitive fields beyond a top-level `viewer`: comment queries select `viewerDidAuthor`, repository fragments select `viewerPermission`, and available repository fields include `viewerHasStarred`, `viewerSubscription`, and viewer email/preferences. A repository read can therefore depend on the authenticated identity. [Official gh query builder](https://github.com/cli/cli/blob/trunk/api/query_builder.go)
- Authenticated REST conditional GETs returning 304 consume no primary quota. Their value depends on unchanged representations; unstable pagination and broad responses reduce hits. This does not establish equivalent GraphQL POST revalidation. GitHub recommends webhooks over polling and backoff after throttling. [REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- `gh api` already offers `--cache <duration>` for explicit response caching. That is an inexpensive option when the offending workload is editable scripts using this command. [gh api manual](https://cli.github.com/manual/gh_api)

## Engineering implications and estimates

1. **Highest value:** record per-resource quota consumption, duplicate reads, repository coverage, and which requests must retain personal identity. Metadata alone suffices; do not log tokens or response contents. Until measured, any predicted multiplier is speculative.
2. **Necessary for correctness:** preserve personal credentials for mutations and identity-sensitive reads, default unknown requests to personal authentication, and route eligible reads only to installations with known access. Trying another app after every 404 risks turning permission differences into misleading results.
3. **Good bounded optimization:** balance eligible reads by available budget/reset rather than blind rotation. Track REST resources and GraphQL separately. This improves use of existing independent budgets but cannot make a personal-only operation app-compatible.
4. **Often cheaper first:** deduplicate simultaneous identical reads and cache with revalidation or short, explicit freshness windows. Scope cache entries by authorization context. This helps repetitive agent polling; it does little for unique scans, rapid changes, or uncached GraphQL workloads. Cache invalidation after writes is required to avoid surprising subsequent reads.
5. **High-cost expansion:** arbitrary GraphQL rewriting/splitting to preserve user fields while fetching repository fields as apps. Mixed repositories, fragments, aliases, partial errors, and changing gh queries make this a continuing compatibility project. Exclude it from the first version.

Planning estimates, not quotations: workload measurement and a compatibility spike are a few engineering days; a narrow personal-use router with conservative fallback and documented tested commands is roughly 1–2 engineering weeks; broad transparent compatibility can extend to several weeks and ongoing upkeep. These assume the existing transport/token foundation is usable; local code testing may change them.

## Benefit model

For one independently constrained budget, let hourly demand be D, duplicate/cache saving fraction c, and eligible app-offload fraction of the remaining work a. Approximate personal demand is D × (1−c) × (1−a). App capacity must still accommodate the offloaded work. Apply this independently to REST buckets and GraphQL points.

Illustration only: 10,000 personal-budget units/hour with 40% cache savings leaves 6,000; moving half of those to apps leaves 3,000 personal units/hour. But if 80% of demand requires personal identity, adding apps alone leaves 8,000 and does not solve exhaustion.

Go/no-go: continue only if the measured eligible/cacheable share can bring personal demand below its budget with useful headroom, and the representative commands retain their output and identity. Otherwise prioritize reducing polling or changing the small number of heavy scripts.


## Concrete upstream evaluation

Inspected proxy commit [4081191](https://github.com/bored-engineer/github-api-proxy/tree/4081191d93a09128278fa8f9e96cb42737f45bfe), its exact pinned rate-limit dependency [2ca9b28](https://github.com/bored-engineer/github-rate-limit-http-transport/tree/2ca9b28f33fcc48efeafcc5c58d93dfc48d1cdc9), and conditional-cache v0.0.7. Clones were downloaded to temporary directories. Existing workspace planning files were read, not changed.

### Improvements worth making

| Improvement | Evidence and user benefit | Incremental effort estimate | Verdict |
| --- | --- | --- | --- |
| Use quota-aware selection | Proxy uses unconditional RoundRobin; its existing dependency already has BalancingTransport scoring remaining capacity against reset time. Avoids selecting an exhausted installation while another is available. | 0.5–2 engineering days for wiring and focused tests; not a full resilient scheduler | High value, small upstream contribution candidate |
| Preserve identity and scope | All configured credentials currently share the same dispatch path. App selection is not gated by method, operation identity, or repository access. Default to caller auth, then allow only verified reads on covered repositories. | 3–5 days for a narrow REST allowlist and tests; permission refresh adds work | Essential for everyday mixed gh use |
| Correct origin forwarding | Proxy rewrites every incoming request to one API base. The socket can also receive uploads and redirected downloads. Preserve known origin handling and never apply App auth to those paths. | 1–3 days for bounded origin handling and representative fixtures | Essential before global gh enablement |
| Setup, rollback and diagnostics | Unix listener exists; native setup/lifecycle is not packaged here. Users need a managed daemon, restoration of prior socket configuration, and a simple explanation of which quota is used. | 1–3 days, macOS only initially | Useful product improvement |
| Safe duplicate suppression | Existing cache revalidates upstream for eligible GET/HEAD; it is not a TTL-only hit path and excludes GraphQL POST. Combine simultaneous identical safe reads under one auth context. | 1–3 days with cancellation/error tests | Add only if repeated traffic is significant |
| Generic GraphQL rewriting | CLI queries may combine repository data and viewer-dependent fields. Splitting them changes execution/error/visibility semantics and has ongoing maintenance costs. | Several additional weeks; hard to bound without a command corpus | Exclude from initial scope |

These estimates overlap and should not be mechanically summed. They assume one experienced engineer, existing authentication libraries, one user, one platform, a small set of repository reads, and focused automated tests. A credible personal MVP is approximately 5–10 engineering days after an initial 1–2 day evidence spike. Broad cross-platform compatibility, shared/multi-user deployment and polished UI are separate scope. Agent-generated code may reduce typing time but does not remove live parity testing or App administration.

The rate-aware selector is reusable but not a complete solution: its fallback picks a random transport when no scored candidate exists, and selection does not know permissions or personal identity. Its per-request reservation is one unit, not a proven GraphQL cost estimator. The transport updates header-based limits but does not implement a shared secondary-throttle cooldown in the inspected code. These are reasons to bound and test reuse, not to assume a one-line fix solves everything. [Selector](https://github.com/bored-engineer/github-rate-limit-http-transport/blob/2ca9b28f33fcc48efeafcc5c58d93dfc48d1cdc9/balancing.go), [transport](https://github.com/bored-engineer/github-rate-limit-http-transport/blob/2ca9b28f33fcc48efeafcc5c58d93dfc48d1cdc9/transport.go), [reservation](https://github.com/bored-engineer/github-rate-limit-http-transport/blob/2ca9b28f33fcc48efeafcc5c58d93dfc48d1cdc9/limits.go).

Cache savings require measurement. The current cache calls the upstream even after finding a cached representation and excludes non-GET/HEAD requests. A 304 may save primary REST quota but still makes a network request; it does not remove secondary-load concerns. [Cache forwarding](https://github.com/bored-engineer/github-conditional-http-transport/blob/v0.0.7/transport.go), [eligible methods](https://github.com/bored-engineer/github-conditional-http-transport/blob/v0.0.7/cacheable.go).

### Validation performed

Ran the workspace's existing `scripts/probe_gh_transport.py` with actual gh 2.100.0, a temporary Unix HTTP server, dummy credentials and isolated gh configuration. All four checks passed: REST with jq, GraphQL POST, absolute pagination links, and upstream error exit code. This proves the tested CLI transport behavior, not the candidate proxy's correctness or equivalence between App and personal responses.

No Go executable was available in this environment, so the upstream binary and its dependencies were not compiled or tested. The top-level proxy checkout contains no Go test files; dependency tests exist. We should budget integration coverage rather than assuming it is already provided.

## Investment decision

Recommend a small, time-boxed extension or focused upstream contributions, not a new general-purpose platform. There is no value in recreating token minting, Unix sockets, metrics or cache backends already present. If a fork accumulates a large personal-identity routing layer, reconsider a smaller daemon using the same libraries; compare only after the spike establishes the necessary surface.

For illustration, with one 5,000-unit user budget and enough App capacity, offloading 20% allows at most 6,250 total units/hour; 50% allows 10,000; 75% allows 20,000. These are mathematical workload ceilings, not measured speedups. Calculate separately for REST core, search and GraphQL points, and cap by total usable App capacity. Personal-only work and secondary throttling remain constraints.

Suggested 1–2 day spike, before a larger commitment:

1. Capture a representative workload in pass-through mode with redacted metadata: resource bucket, method, repository, query shape, repeated requests and timing. Do not start logging the user's real traffic without selecting the representative commands/session.
2. Rank quota consumption by request family; estimate savings from caching and from App-eligible reads separately. Include the user's other tools consuming the same budget, even if they do not pass through gh.
3. Compare a small, stable read-only fixture with personal auth and one installation. Check meaning, fields, errors and pagination, not only successful status codes. Live App credentials/installations are not configured in this evaluation.
4. Continue if achievable savings take peak personal consumption below about 80% of the relevant budget and cover the most disruptive workflows. The 80% threshold is a suggested engineering headroom target, not a GitHub rule.
5. If savings are small or mostly require arbitrary GraphQL rewriting, stop the proxy expansion and fix repeated polling, use existing caching, or route a few controlled scripts directly through one App.

Return-on-effort illustration: a 40–80 hour MVP that saves 30 minutes of genuinely lost work each workday pays back in roughly 80–160 workdays before maintenance. If it prevents automated jobs from failing unattended, value can be much greater. Actual interruption cost was not provided, so a firm economic return cannot be claimed.
