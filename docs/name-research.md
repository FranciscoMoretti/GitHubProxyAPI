# Command-name research

Checked on 2026-09-13.

## Decision

Use `@franciscomoretti/ghpa` as the public npm package and `ghpa` as its primary
command. Retain `githubproxyapi` as an equivalent, collision-free executable
fallback. npm rejected the unscoped `ghpa` package name through its similarity
protection despite the name being unregistered.

## Findings

- `gpa` is unavailable for a general-purpose CLI. Homebrew's `gpa` formula
  installs the GNU Privacy Assistant executable under that name. Exact `gpa`
  packages also exist on npm and PyPI, and the acronym is dominated by “grade
  point average” in general search.
- `ghpa` has no exact npm package, Homebrew formula, crates.io crate, RubyGem, or
  Docker Hub official image at the time of checking.
- The GitHub account namespace `github.com/ghpa` is occupied, and several
  unrelated repositories are named `ghpa`. The repository name remains
  available under `FranciscoMoretti`.
- The PyPI distribution `github-pr-analyzer` already installs a `ghpa`
  executable. PyPI Stats reported 24 downloads in the preceding month, so this
  is a real but currently small collision in the same developer-tool category.
- `ghpa.com` and `ghpa.dev` are registered. RDAP returned no registration for
  `ghpa.app` or `ghpa.io`, but domain availability must be confirmed with a
  registrar immediately before purchase.

Keeping the long executable avoids forcing a rename if a user already has the
Python `ghpa` command, while the short executable is suitable for normal use.
