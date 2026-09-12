# Credential routing research

Researched 2026-09-12 against GitHub documentation, GitHub CLI `trunk`, and GitHub's Octokit schema snapshot. This is an implementation recommendation, not a claim that all routes below have passed live parity tests. The installed CLI version and its actual requests must be captured before freezing fixtures; `trunk` links can change.

## Recommendation

Keep the original user credential as the default route. Move a request to an app installation only when a reviewed rule proves both adequate access and equivalent response semantics for that request shape. Build a small request router, not a reimplementation of `gh` commands. Start with a few verified REST reads and selected repository GraphQL queries; expand using the user's measured workload.

The central compatibility issue is identity, not just permissions. GitHub's published schema states that `Repository.viewerPermission` is null when authenticated as a GitHub App. It also defines `viewer` as the authenticated user, `viewerDidAuthor` in terms of that viewer, and `affiliations` filters relative to the viewer. Replacing a user credential changes the meaning of these requests even when the app can read the repository. [Published GraphQL schema](https://github.com/octokit/graphql-schema/blob/master/schema.graphql)

## Evidence from current `gh`

- `GitHubRepo` and `IssueRepoInfo` request `viewerPermission`; push and triage helpers consume it. Repository-network discovery also requests `viewer { login }`, and fork discovery uses viewer affiliations. Preserve these entire operations on the user credential. [Repository queries](https://github.com/cli/cli/blob/trunk/api/queries_repo.go)
- The shared comments fragment includes `viewerDidAuthor`; the repository fragment includes `viewerPermission`. The repository JSON field catalog includes viewer star, subscription, commit-email, and permission fields. A `--json` option can therefore change an otherwise routable read into a user-only request. [Query builder](https://github.com/cli/cli/blob/trunk/api/query_builder.go)
- Default `gh pr view` includes comments, projects, reviews, and status checks. Its default query should initially remain user-authenticated; checking only the top-level repository is insufficient. [PR view defaults](https://github.com/cli/cli/blob/trunk/pkg/cmd/pr/view/view.go)
- A plain `gh pr list` uses a repository connection with explicit owner/repository variables and a limited default field set. This is a promising parity-test target. [PR list defaults](https://github.com/cli/cli/blob/trunk/pkg/cmd/pr/list/list.go), [Repository PR lister](https://github.com/cli/cli/blob/trunk/pkg/cmd/pr/shared/lister.go)
- Adding draft, author, assignee, search, or label filters to `gh pr list` switches it to GraphQL search. Support cannot be assigned at the command-name level. [PR list dispatch and search](https://github.com/cli/cli/blob/trunk/pkg/cmd/pr/list/http.go)
- The issue-list repository query has explicit repository variables and configurable fields/filters. Treat its simple form as another candidate, while separately evaluating search and expanded JSON variants. [Issue list queries](https://github.com/cli/cli/blob/trunk/pkg/cmd/issue/list/http.go)

## Access and response shape

Installation requests act as the app and can access only its authorized resources with the required permissions. Some REST endpoints do not accept installation tokens. GitHub expressly recommends testing the permissions needed by actual GraphQL queries. Tokens expire after one hour. Multiple token refreshes for one installation are not additional installations or additional quota pools. [Installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)

REST reads can also change shape. `GET /repos/{owner}/{repo}` exposes security settings according to the caller's administrative role and requires additional Contents permissions for merge settings. Consequently, the entire `/repos/...` namespace is not a safe routing rule. [Get a repository](https://docs.github.com/en/rest/repos/repos#get-a-repository)

Endpoint documentation and `X-Accepted-GitHub-Permissions` help determine required permissions, including endpoints with alternative or combined requirements. A permission match is necessary but does not prove that the response is independent of identity. [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)

Search is especially unsuitable for a broad initial rule: GitHub can silently return only accessible resources when a multi-resource search includes inaccessible repositories. Success status and an empty result are not evidence of parity. Authenticated REST search ordinarily has 30 requests/minute; code search has 10/minute. [Search behavior and limits](https://docs.github.com/en/rest/search/search)

## Initial routing policy

These are proposed product rules; the candidate rows require passing the fixture suite before enabling them.

| Request class | Initial decision | Reason or prerequisite |
| --- | --- | --- |
| Unknown REST route, HTTP method, query argument, media type, or API version | Original user credential | Future CLI/API changes remain functional through passthrough. |
| REST writes; GraphQL mutations | Original user credential | Preserve actor and effects; no cross-credential write retries. |
| `/user`, user/account discovery, notifications, subscriptions, stars, permissions, global search | Original user credential | User identity or visibility is part of the operation. |
| `GET /rate_limit` and GraphQL `rateLimit` | Original user credential | Preserve the meaning of asking for the user's budget; expose pool metrics separately. |
| `GET /repos/{owner}/{repo}` | Original user credential | Permission-dependent response fields. |
| Repository Git blob/tree reads | App candidate | Exact method, route, options, API version, known repository access, Contents read permission, and byte/JSON parity. |
| Simple `PullRequestList` / `IssueList` GraphQL shapes | App candidate | Recognized complete AST; only certified fields/arguments; explicit repository; no viewer or visibility-sensitive traversal. |
| GraphQL `viewer*`, `viewer`, affiliation filters, search, arbitrary node IDs, mixed repositories, unknown fields | Original user credential | Keep whole request together; do not split and synthesize user/app results in v1. |
| Conditional or cursor requests without certified credential equivalence | Original user credential or existing credential affinity | Do not assume an ETag or pagination cursor is portable between principals. |

Blob and tree retrieval explicitly support installation tokens with Contents read permission, making them narrow REST starting points. Their actual media types, truncation behavior, and response bytes still belong in parity fixtures. [Git blobs](https://docs.github.com/en/rest/git/blobs#get-a-blob), [Git trees](https://docs.github.com/en/rest/git/trees#get-a-tree)

Routing mechanics:

1. Validate a fixed GitHub upstream and the accepted local caller before examining credentials. Do not treat an app's broader access as automatic authorization for an arbitrary supplied PAT. Scope initial rollout to the known local user and explicitly enrolled repositories.
2. Classify the complete request. Use a GraphQL parser and a certified operation structure, never a substring test, operation name, or `POST == write` shortcut. Resolve fragments, actual field names beneath aliases, selected operations, variables, defaults, and directives. Malformed, ambiguous, oversized, or unsupported documents pass through unchanged on the original credential.
3. Filter installations by host, explicit repository authorization, current installation state, and required permission sets. Retain repository IDs as well as names so renames or transfers cannot accidentally reuse stale access decisions.
4. Select from eligible installations with usable capacity, reserving in-flight budget. Fall back to the original user credential when no installation qualifies. App-first selection reserves personal capacity for identity-dependent operations.
5. Preserve request method, path, query, body, API version, media types, pagination, and response semantics. Never rewrite GraphQL results to pretend an app is the user. Expose the actual upstream rate-limit headers and report aggregate operational metrics through the proxy's own status command.

## Quota and failure handling

GitHub's ordinary user REST limit is shared across personal tokens and user-authorized app/OAuth tokens. Installation REST limits begin at 5,000 requests/hour and can scale. Primary exhaustion is indicated by HTTP 403/429 with remaining zero. Secondary throttling can occur despite spare primary quota; it has concurrency, rate, and other constraints, including undisclosed ones. Honor `Retry-After`; otherwise follow the documented reset or minimum one-minute backoff. Repeated failures require bounded exponential backoff. More installations do not establish independent secondary-limit capacity. [REST limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

GraphQL has a separate point-based budget: ordinary installations start at 5,000 points/hour. It can report primary exhaustion in HTTP 200 with errors and zero remaining; secondary failures can also appear in HTTP 200. Timeouts and resource exhaustion may return errors or partial results, so HTTP success alone cannot decide health. [GraphQL limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)

Track budgets by `(GitHub host, principal/installation ID, resource)`, not token string. At minimum distinguish `core`, `search`, `code_search`, and `graphql`; retain unknown resource names for future APIs. Refreshing a token must retain the installation's accounting. GitHub's rate-limit endpoint describes these resources separately and supports installation tokens. [Rate-limit endpoint](https://docs.github.com/en/rest/rate-limit/rate-limit)

Proposed failure rules:

- Stop assigning traffic to an exhausted primary bucket until reset. An already certified read may use another independently eligible, non-exhausted bucket; never continually retry the exhausted installation.
- Apply a conservative shared cooldown for secondary throttling and reduce concurrency; do not rotate tokens in response to that signal. Keep this separate from primary exhaustion.
- Distinguish authentication failure, missing permission, absent repository, primary exhaustion, secondary throttling, and transient transport failure. A generic 403 or 404 is not a reason to cycle through every credential.
- On a recognized stale installation-token failure, refresh once with single-flight coordination. Disable/quarantine revoked or suspended installations. Unknown errors retain upstream meaning.
- Do not automatically replay mutations after timeouts or partial failures. Preserve GraphQL partial `data` plus `errors`; do not discard partial data or silently substitute a different principal's result.
- Prefer response headers for accounting. Authenticated conditional 304 responses can save primary capacity, but caches need credential-aware keys and a separate parity proof before sharing across principals. [REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)

## Fixtures and acceptance tests

Use a mock GitHub upstream for exhaustion and failures. A live test should demonstrate separate accounting with a small number of requests, never spend thousands of requests solely to hit a real limit.

| Fixture group | Required cases | Pass condition |
| --- | --- | --- |
| CLI parity | Explicit `-R` and repository auto-discovery; plain PR/issue list; filtered list; PR/issue view; JSON field subsets; `gh api --paginate`; user lookup | Same stdout, stderr, exit status, relevant ordering, and response meaning as direct `gh`; expected routing per actual request. |
| Identity | `viewer`; nested/aliased `viewerPermission`; comments with `viewerDidAuthor`; affiliations; `@me`; personal writes | User credential throughout the identity-sensitive request; writer identity remains the human. |
| GraphQL parser | Aliases, fragments, directives, variables, operationName selection, multiple operations, comments/string literals containing `mutation` or `viewer`, invalid JSON/GraphQL, unknown fields | No unsafe app admission; allowed simple queries remain routable despite harmless syntax variation if normalization supports it. |
| Visibility | Public and private repo; installation missing repo; unequal app permissions; private fork or linked issue outside installation; organization repo only user can read; empty result | No missing rows, unexpected null fields, wider access, or altered errors caused by switching principal. |
| REST representation | JSON/raw blob; recursive/truncated tree; HEAD if supported; ETag/304; nonstandard Accept and API version; encoded route/query values | Exact routing allowlist and preserved bytes/headers; unknown variants use user path. |
| Scheduler | Two tokens for one installation; two different installations; one exhausted resource with another healthy; simultaneous requests near budget zero; cancellation | No double-counted capacity, oversubscription beyond configured reservations, or REST/GraphQL bucket conflation. |
| Failure classification | 403 permission; 404 hidden repo; REST 429; secondary 403 with remaining positive; GraphQL 200 rate errors; mixed data/errors; network failure after mutation | Appropriate cooldown/fallback; bounded retries; no mutation replay; no token cycling on secondary failure. |
| Token lifecycle | Clock skew; expiring token; concurrent refresh; revoked key; removed/suspended installation; changed repository selection | Single-flight refresh, no secret logging, known principal accounting retained, stale eligibility removed. |

For live parity, capture a small controlled workload against a dedicated repository with one user and two distinct app installations. Freeze repository changes during comparisons where practical; compare semantic JSON and separately account for intentional per-request headers such as request IDs and rate limits. First record user-only results, then force each candidate app in turn, then test scheduling. The ordinary user response must remain authoritative until a request shape is certified. Keep raw authorization headers, private keys, tokens, signed download URLs, and private response bodies out of checked-in fixtures.

## Open questions before promising capacity gains

- What fraction of this user's exhausted budget comes from certified repository reads versus personal discovery, search, and viewer-dependent GraphQL? Measure this in passthrough mode first.
- Which existing apps are distinct installations, what repositories and permission combinations do they cover, and do those overlap the actual workload?
- Do current `gh` default-list queries produce identical objects under the user's specific apps, including authors, forks, private relationships, and pagination? Documentation does not prove this; live parity is required.
- GitHub does not document a complete GraphQL field-to-app-permission matrix or guarantee secondary-limit independence across these installations. Capacity should be reported from measured eligible requests and observed buckets.
