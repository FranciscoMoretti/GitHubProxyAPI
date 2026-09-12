# Live validation — 2026-09-12

The proxy was validated against `FranciscoMoretti/GitHubProxyAPI` with the
official `gh` executable and the user's existing GitHub login.

## Installed readers

| Alias | App ID | Installation ID | Repository access |
| --- | ---: | ---: | --- |
| `cli-a` | 4911718 | 161088642 | Selected repository only |
| `cli-b` | 4911749 | 161088757 | Selected repository only |

Both registrations grant read access to Actions, Checks, Contents, Issues,
Metadata, Pull requests, and Commit statuses. Each registration has one active
private key. The local keys and proxy configuration are stored under
`~/.config/githubproxyapi` with user-only filesystem permissions; no credential
material is stored in this repository.

## Results

- `npm run check` passed: TypeScript checking, 47 tests, and the production build.
- Four identical Git-tree reads through `githubproxyapi exec -- gh api ...`
  returned the same expected SHA. The proxy routed three to `cli-a` and one to
  `cli-b` with zero errors.
- A subsequent direct `gh api` Git-tree read, after `enable-gh`, routed to
  `cli-b`. This confirms the official CLI uses the proxy without wrapping or
  reimplementing its commands and flags.
- Two `gh api user` calls returned `FranciscoMoretti` and were classified as
  personal/unknown routes. This confirms identity-dependent traffic retains the
  personal credential.
- GitHub reported separate `core` budgets for the personal credential and both
  installations. Each installation reported a 5,000-request limit.
- `githubproxyapi doctor` reported two healthy Apps and one enrolled caller.

No live write was needed. The offline integration suite verifies that every
non-GET request remains personal and is dispatched at most once. The global
`gh` socket setting is currently enabled. Run `githubproxyapi disable-gh`
before `githubproxyapi stop` to restore the previous setting safely.
