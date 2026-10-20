# Managed availability

`ghpa enable-gh` installs a per-user socket-activated service, verifies its private
socket and generation ID, and only then changes `gh`'s `http_unix_socket`.
The official `gh` binary and personal authentication remain unchanged. No shell
wrapper, placeholder credential, whole-command replay, or crash retry of an
ambiguous request is introduced.

## Commands

```sh
ghpa enable-gh          # first setup, repair, or upgrade to the installed package/runtime
ghpa service status    # manager output, local HTTP health, generation, PID, pending recovery
ghpa disable-gh         # restore the prior socket key; leave service installed
ghpa service uninstall # restore transport before stopping/removing service
```

Run `service uninstall` before removing the npm package if you also want to remove
the service. `disable-gh` works without a healthy daemon or valid App configuration.
It restores the exact previous socket setting, including absence, preserving other
YAML settings/comments. It does not modify `hosts.yml`, the Keychain, or tokens.
Conflicting edits to the socket key are refused rather than overwritten.
Use the same `GITHUBPROXYAPI_CONFIG` and `GH_CONFIG_DIR` used for installation.

`start`, `serve`, `stop`, `exec -- gh …`, and `enable-gh --manual` retain manual/scoped
operation. `start`/`stop` refuse to manage an installed supervised instance; its
listener remains available even if a process stops. `disable-gh` is the immediate
escape hatch. Manual mode does not promise automatic availability.

## Platform implementation

**macOS:** a LaunchAgent in `~/Library/LaunchAgents`, bootstrapped into `gui/<uid>`.
The plist's `Sockets/Proxy` entry owns the Unix stream socket (mode 0600); its parent
is owned by the user with mode 0700. Socket demand starts the process. A small C
launcher calls `launch_activate_socket("Proxy", …)`, requires exactly one descriptor,
moves it to fd 3, clears close-on-exec, and execs the absolute Node runtime. There
is no native Node addon or Node ABI dependency. Node itself does not call the
launchd API. Launchd throttles launches to a five-second interval; socket demand
activates a replacement after exit. The service is available again after GUI login,
not before login or during logout.

This first implementation compiles the launcher during setup using `/usr/bin/cc`.
Apple Command Line Tools are required (`xcode-select --install`). Compilation or
bootstrap failure leaves the prior transport intact. Prebuilt, signed launcher
artifacts are not included. Production launchd check-in still requires the live
acceptance below; local tests compile/link the real launcher and confirm it fails
closed outside launchd, without registering an agent.

**Linux:** a systemd user `.socket` enabled under `sockets.target`, with a matching
`.service`. The daemon validates `LISTEN_PID`, `LISTEN_FDS=1`, and
`LISTEN_FDNAMES=ghpa`, consumes fd 3, and clears activation metadata. The listener
survives the daemon's death. `Restart=on-failure`, a two-second restart delay, and
five starts per 30 seconds bound crash loops. Reaching a start/trigger limit can
require repair; `enable-gh` stages fresh verified units. A running user manager is
required. User login normally starts it; lingering for availability while logged
out is an explicit administrator decision and is never enabled by GHPA.

Both platforms pass the listening descriptor to Node's `server.listen({fd})`.
Managed code never unlinks or chmods the OS-owned listener. The ordinary bind path
retains stale-socket protection for manual use. Private directories/socket modes
are checked before changing `gh`. The API timeout and 64-request bound also cover
requests waiting for the first unknown-budget probe. Known exhaustion and shared
secondary cooldown still reject traffic; waiting is not a request retry.

## Installation, upgrades and failures

Each generation is stored under the config directory's private `service/` folder.
Setup snapshots the executable Node binary, built JS, and production dependency
closure. Definitions contain absolute paths and do not depend on the user's shell,
PATH, npm symlinks, working directory, or version-manager shims. Credentials and
private keys are not copied; the daemon reads the original GHPA config/key paths.
The clean-environment runtime preflight validates configuration before registration.

This snapshot prevents removal of an npm installation or a Node version-manager
version from deleting the active executable. It does **not** bundle operating
system libraries: a Homebrew/distribution Node binary may still depend on shared
libraries outside the snapshot. Removing those libraries can break it. Prefer an
official standalone Node distribution; re-run `enable-gh` for runtime/security
updates. Snapshotting means npm/Node upgrades do not silently update the daemon.
Production dependencies currently have no conflicting transitive versions; the
snapshot copier assumes one version per dependency name.

An upgrade starts a new generation with a distinct socket while the previous
service remains available. Health must identify the new generation within 12
seconds before the atomic gh config switch. OS commands time out after 15 seconds.
Only after the switch does setup stop/remove the old generation. A durable journal
records unfinished installation and cleanup. Repeating `enable-gh` or
`service uninstall` reconciles that journal against the committed gh socket value,
including interruption between writing the transport backup and editing YAML.
A committed healthy generation is retained if old-generation cleanup fails.

Setup/config mutations are serialized by private locks. Concurrent setup waits up
to ten seconds. If an installer is killed while holding a lock, inspect the
reported `owner.json` PID; only after confirming that installer is gone, remove
the reported lock directory and retry. Automatic stale-lock stealing is avoided
because PIDs can be reused. This is an installer-recovery case; daemon crashes
never take or leave setup locks.

Upgrade/uninstall can interrupt in-flight requests. Do them during a quiet period.
The existing quota state is periodically persisted; observations immediately before
a crash can be lost. Socket activation queues new connections and restores future
service. It cannot recover an accepted connection, determine whether a write reached
GitHub, or guarantee availability when configuration/runtime/OS installation is
broken. A queued client can hit its own timeout while the OS is throttling a broken
service. Inspect the operation's outcome before manually retrying a failed write.

App token/key failures fall back to personal forwarding for safe requests when the
existing access, timeout and quota policy permits. They do not prevent listener
startup. Secondary throttling and actual personal exhaustion still apply.
`doctor` separately checks App keys and can report their failure even when personal
forwarding is healthy.

A local socket failure is **not evidence of an invalid GitHub token**. `gh auth
status` can summarize a transport failure as an invalid token. First inspect
`ghpa service status`; restore/repair transport before investigating authentication.
A fixture GitHub 401 with a healthy local status is tested separately from an
unreachable socket. Fixtures use dummy tokens and never refresh real credentials.

## Validation and remaining acceptance

`npm run check` builds the package, type-checks, and runs the suite. Isolated tests
use temporary config/home/cache directories, dummy credentials, local upstreams,
and real `gh`. A small Python process holds the real Unix listener, starts a Node
child only on demand, preserves fd 3 across crashes, and reaps children. It does
not register a launchd/systemd service. Tests cover:

- Eight simultaneous first calls before any daemon exists; one daemon activation.
- SIGKILL, unchanged listener inode, and successful subsequent calls.
- A write whose body reached the upstream followed by process death: one write,
  a failed command, and a successful independent later read.
- Personal authentication preservation and upstream 401 versus local failure.
- Setup/upgrade/rollback/uninstall, YAML restoration, concurrent installers,
  configuration conflicts, interrupted journal/backup writes, failed cleanup,
  and a bounded health deadline for a mismatched process.
- A private runtime snapshot launched with no shell environment, real macOS
  native compilation/plist lint, and offline systemd unit verification on Linux.
- Cold-budget waiting without bypassing discovered exhaustion; unavailable App
  credentials preserving personal forwarding.

CI runs the suite on both Ubuntu and macOS. This local implementation run was on
macOS arm64, standalone Node 22.23.1. Linux CI results and real OS
login/reboot/check-in are not implied by the isolated supervisor tests.

Live macOS acceptance on 2026-10-20 verified launchd registration, real GitHub
reads, and demand activation after terminating the reported daemon PID: four
concurrent reads succeeded with a new PID and the same socket inode. A real
logout/reboot was not performed. The Homebrew Node executable failed the clean
snapshot preflight due to a missing libnode dylib; standalone Volta Node passed.

For live acceptance, use a disposable OS account/VM with its own GHPA and gh
configuration. These steps intentionally register services and are **not** run by
the automated test suite:

1. Build/install, initialize a private config, and run `enable-gh`. Inspect the
   manager definition and socket permissions. `status` must report its generation.
2. Run ordinary official `gh` against a chosen read-only account/fixture. Log out
   and in (then reboot/login); use `gh` before any manual GHPA command.
3. Kill only the PID reported by this fixture's `status`, then issue several reads.
   Verify a new PID and the same managed socket. Repeat to inspect OS start limits.
4. Upgrade the package/runtime, re-run `enable-gh`, and verify the old generation
   is removed only after the new one responds. Try an intentionally invalid
   candidate and confirm prior transport survives.
5. Run `service uninstall`, verify the exact prior socket key and unrelated YAML,
   and confirm no fixture service remains enabled. Never use a live write as an
   automatic crash/replay acceptance probe.

## Review map

1. **Managed lifecycle and transactional integration:** `src/service.ts`,
   `src/files.ts`, CLI/control changes, package inclusion and operational docs.
2. **Socket activation:** `native/launch.c`, `src/activation.ts`, inherited-listener
   support and bounded cold-budget waiting in `src/proxy.ts`.
3. **Fixture evidence:** `test/service.test.ts`, `test/activation.test.ts`, fixture
   supervisor/worker, control/proxy regressions, and the two-platform CI matrix.

## References

- The installed Apple SDK's `launch(3)` manual and `<launch.h>` specify
  `launch_activate_socket`, its allocation ownership and error conditions.
- Apple's [launchd plist source](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5)
  documents socket definitions and modes.
- systemd's [descriptor protocol](https://github.com/systemd/systemd/blob/main/man/sd_listen_fds.xml)
  and [socket unit reference](https://github.com/systemd/systemd/blob/main/man/systemd.socket.xml)
  define fd 3, environment validation, activation and ownership.
- systemd's [socket parser](https://github.com/systemd/systemd/blob/main/src/core/load-fragment.c)
  takes `ListenStream` as a whole path (not shell-quoted words); executable and
  environment assignments have separate quoting/specifier rules.
- Node's [net server API](https://nodejs.org/api/net.html#serverlistenoptions-callback)
  supports listening on an inherited descriptor.
