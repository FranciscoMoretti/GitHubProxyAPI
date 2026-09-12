# GitHub App onboarding and live validation

Planning research, verified against GitHub's documentation on 2026-09-12. No account changes or live authenticated requests were made for this note.

## Proposed first setup

Reuse two existing GitHub Apps installed on the same personal account, grant both access to one test repository, and retain the personal credential already used by `gh`. Prefer an existing private repository with a README, an issue, a pull request, and a completed Actions run. A private repository verifies installation grants; a public-only test can accidentally succeed through public access. Missing fixtures can be covered by the local test server initially.

Record this non-secret inventory for each app:

| Field | Purpose |
| --- | --- |
| App slug, app ID, client ID, owner | Identify the registration and sign app authentication requests |
| Installation ID, account login, suspension state | Identify the separate credential and determine eligibility |
| Granted permissions and selected repository IDs | Build the routing eligibility map |
| Local private-key path and public-key fingerprint | Load and verify the signing key without putting it in configuration |

GitHub lists app/client IDs on the app settings page. A JWT-authenticated `GET /app` verifies the registration; `GET /app/installations` returns the app's installations and their permissions. Use `GET /repos/{owner}/{repo}/installation` when checking a specific repository. Installation access tokens can then call `GET /installation/repositories`; paginate these inventories. [JWT identifiers](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app), [app endpoints](https://docs.github.com/en/rest/apps/apps), [installation repositories](https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-app-installation).

## Browser setup procedure

1. Use the user's signed-in GitHub browser session. Open account **Settings → Developer settings → GitHub Apps**, and inspect the existing registrations before creating any new app.
2. Open each selected app's settings and record its identifiers, current permissions, and key fingerprints.
3. Use **Install App** to install it on the personal account, selecting **Only select repositories** and the same test repository for both apps. For existing installations, inspect their repository selection and add the test repository if needed. Personal-account installation does not confer access to private repositories owned by an organization; installation belongs to the account that owns those resources. A private app is restricted to installation on its owning account. [Installing your own app](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app), [installation requirements](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party).
4. If a selected app lacks a necessary read permission, add that permission and accept the updated installation grant. GitHub keeps an installation's old permissions until the account owner approves the new ones. Preserve unrelated configuration in reused apps; preferably restrict the proxy's minted token instead of reducing permissions that an existing integration uses. [Permission changes](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app#about-changes-to-permissions).
5. Locate the existing PEM by its local path, or use the app's **Private keys → Generate a private key** to download an additional key. GitHub stores only the public portion, so an old private key cannot be downloaded again. Additional keys can coexist, up to 25 per app; onboarding must not delete or revoke older keys. Verify the downloaded key's public-key fingerprint against the app settings. GitHub downloads PKCS#1 RSA PEM files. [Private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps).

Proposed local handling: keep PEMs in an owner-only application configuration directory outside the repository, with file permissions `0600` and directory permissions `0700`. Store paths in configuration, never PEM text, JWTs, or installation tokens in logs or checked-in files. Reuse `gh`'s personal authentication through the approved transport; the user need not paste a token or private key into chat.

The user handles any login, passkey, security-key touch, 2FA, or sudo-mode confirmation presented by GitHub. Browser automation can continue through ordinary app forms after that. These prompts depend on the current session; they are not an obligatory extra confirmation at every step. [GitHub sudo mode](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/sudo-mode).

## Initial read permissions

These permissions cover the stated REST probes. They do not guarantee that every default `gh` view or GraphQL query is semantically interchangeable between a person and an app.

| Repository permission | Initial test | Official reference |
| --- | --- | --- |
| Metadata: read | Repository identification | [Get a repository](https://docs.github.com/en/rest/repos/repos#get-a-repository) |
| Contents: read | Read an existing file, such as README.md | [Repository content](https://docs.github.com/en/rest/repos/contents#get-repository-content) |
| Issues: read | List repository issues | [Repository issues](https://docs.github.com/en/rest/issues/issues#list-repository-issues) |
| Pull requests: read | List PRs and inspect their files | [Pull requests](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests) |
| Actions: read | List completed workflow runs | [Workflow runs](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-repository) |
| Checks: read — optional extension | Read PR check runs | [Check runs](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference) |
| Commit statuses: read — optional extension | Read a commit's combined status | [Commit statuses](https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference) |

Do not request organization or account permissions for this first personal-repository setup. Actual GraphQL requests need permission testing; GitHub explicitly recommends testing the intended queries. Route queries involving personal identity or unknown access requirements through the personal credential until they are classified. [Choosing permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).

## Authentication lifecycle

Sign app JWTs with `RS256`, use the client ID as `iss` (GitHub's recommendation; app ID also works), set `iat` 60 seconds behind current time to allow clock drift, and set `exp` no more than 10 minutes ahead. Send JWTs as `Authorization: Bearer …`. [JWT requirements](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app).

Call `POST /app/installations/{installation_id}/access_tokens` using that JWT. Specify the test `repository_ids` and only the necessary read `permissions`; a token cannot exceed the installation's grants. The response includes `expires_at`, permissions, and token. Installation tokens expire after one hour. Proposed implementation: cache in memory by installation and scope, refresh five minutes before expiry, and coalesce concurrent refreshes into one request. Treat tokens as opaque strings: GitHub began rolling out variable-length `ghs_APPID_JWT` tokens in April 2026. [Installation token generation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

## Minimal live acceptance run

Run after local tests pass. Use a test-only local configuration and cap the whole live session at **60 upstream requests**, sent serially. Count authentication/discovery calls as well as command traffic. Stop on a secondary limit and honor GitHub's backoff. The request cap is a proposed test constraint, not a GitHub limit.

1. Verify both app identities and installations, obtain one token per installation, and confirm each token's test-repository access. Show IDs, scope, expiration, and rate-limit counters only.
2. Read `/rate_limit` once using each of the personal, app A, and app B credentials. Run two small repository reads through A and then two through B; inspect returned `x-ratelimit-resource`, remaining, used, and reset values. Confirm requests route to distinct installation identities and their tracked budgets. Concurrent unrelated app usage may affect absolute counters, so do not demand exact global deltas.
3. Execute direct personal and proxied pairs for small, bounded commands: `gh api repos/OWNER/REPO/contents/README.md`, `gh issue list -R OWNER/REPO --limit 2 --json number,title,state`, `gh pr list -R OWNER/REPO --limit 2 --json number,title,state`, and `gh run list -R OWNER/REPO --limit 2 --json databaseId,status,conclusion`. Compare output and exit status, inspect which requests actually used apps, and retain unknown GraphQL shapes on personal fallback. Command success alone is insufficient evidence of quota offloading.
4. Use the test-only scheduler configuration to give A a synthetic budget of two requests, then verify eligible reads move to B. Mark both apps unavailable locally and verify personal fallback. Do not exhaust actual GitHub quotas to test this behavior.
5. Exercise personal identity with `gh api user --jq .login`; verify the proxied response matches the direct response and the route remains personal. Validate write routing and ambiguous retry behavior against the local fake GitHub server. A live write test, if later needed, should be a separate named fixture operation.
6. Force the local token cache's refresh threshold to obtain one replacement installation token and verify another read. Cover clock drift, real expiration timing, revoked-key failures, and concurrent refresh races using the fake server and controlled clock.
7. Remove the test transport override and confirm an ordinary direct `gh` request still works. Report successful command comparisons, app-routing coverage, observed budgets, total request count, and unresolved command/query cases.

GitHub installation REST quotas start at 5,000 requests/hour; user tokens share the personal user's limit. Response rate-limit headers identify the charged resource. `/rate_limit` does not consume primary quota but can count toward secondary limits, so use response headers after initial inspection. Distinct observed buckets plus synthetic rollover establish the mechanism without a high-volume live run. [Rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
