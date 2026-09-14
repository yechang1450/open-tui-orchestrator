# Changelog

Notable changes, newest first. Every entry pairs a package version with a core version —
`open-tui-orchestrator --version` prints both (`open-tui-orchestrator <version> (core <core>)`).

## 0.9.3 — core 1.14.3

### Fixed

- **`--install-deps` is now reachable exactly when you need it.** If your environment sets
  `ORCH_AGENT=codex`, the wrapper used to run the SDK dependency check (and the engine to
  `import` `@openai/codex-sdk` at load) *before* the bootstrap entry could run — a deadlock for
  anyone with missing dependencies. The bootstrap now runs before the engine, and its
  implementation lives in `scripts/install-deps.mjs`, which imports nothing but Node builtins.
- **A successful install is no longer reported as a failure.** The dependency probe was computed
  once before the install, so `npm ci` succeeding (exit 0) still produced
  `FATAL: dependency install failed`. It is re-checked after the install, and the success path now
  has a regression test (offline, with an npm stub).
- `ORCH_NPM_BIN` (new) points at a custom or corporate npm; a missing toolchain is reported with
  the manual fallback command instead of a Node stack.

### Changed

- **Publishing metadata**: `private` removed, `description` / `keywords` / `author` / `license` /
  `repository` / `homepage` / `bugs` added, and an explicit `files` list now excludes `test/` and
  `scripts/node_modules` (without that exclusion the tarball picked up 385 MB of dev
  dependencies — 143 MB packed; with it, 89 files / 292 kB). `npm publish --dry-run` is green.
- **Machine identity stripped from the repository**: 18 tracked files / 77 occurrences of the
  authoring machine's user name are normalized to `<user>`, and the root causes are fixed so
  future artifacts stay clean (evidence collector, profile adapter provenance, the shipped hermes
  profile).
- npm is invoked through `node_modules/npm/bin/npm-cli.js` when available (no `shell: true`,
  no `DEP0190` warning, no shell-quoting of paths).

## 0.9.2 — core 1.14.2

### Added

- **`--install-deps`** — a first-class entry that installs this package's own locked SDK
  dependencies (`@lydell/node-pty` for the invisible ConPTY carrier, `@openai/codex-sdk` for
  Codex-hosted runs). Idempotent (a second run prints `already-present` without touching the
  network), stdout stays pure data, and a failure names the manual fallback command. A public
  install is now three commands.
- **`INSTALL.md` / `INSTALL-zh.md`** and a README install section, plus
  `docs/public-readiness.md` — an explicit list of what is done and what is still missing before
  this can be released publicly.

## 0.9.1 — core 1.14.1

### Fixed

- Coordinator mutex tickets are reclaimed on **every coordinator-directory resolution** (an idle
  machine no longer keeps residue until the next transaction), and the helper polls its release
  file every 100 ms instead of ~1 s — tickets vanish within ~300 ms. 576 leaked tickets were
  observed on a long-lived machine and removed.

## 0.9.0 — core 1.14.0

### Fixed

- **Coordinator mutex hardening.** The wait was hard-coded at 20 s inside the helper and 30 s on
  the JS side, so nine contending parents under load produced false
  `Coordinator mutex acquisition failed` results (2/9 in a full-suite run). Now: tunable wait
  (`ORCH_MUTEX_WAIT_MS`, default 60 s), retries with exponential + jittered backoff
  (`ORCH_MUTEX_RETRIES`, default 2), a JS-side bound derived from the same value, and age-based
  ticket reclamation (`ORCH_MUTEX_TICKET_TTL_MS`, default 10 min).
- `queue-backoff`'s end-to-end failure output now carries the per-block reason.

## 0.8.0 — core 1.13.0

### Added

- **Machine-caller failure contract.** Every public entry fails closed with exactly one
  `[orchestrator] FATAL: <reason>` line (Node stacks only with `ORCH_DEBUG=1`); exit codes are
  0 success / 1 refused / 2 usage.

### Fixed

- `--verify-run` / `--resume-run` on an unknown run id now answer `Run not found: <id>` instead of
  a raw `ENOENT` plus a four-frame stack.
- `--watch <unknown run>` used to poll **forever** with no output; it now honours a bounded grace
  (`ORCH_WATCH_GRACE_MS`, default 60 s — the run directory may legitimately not exist yet while
  `--run-windows` is still planning) and reports a summary that disappears mid-watch.

## 0.7.0 — core 1.12.0

### Added

- Queue wait backoff: capacity/conflict waiters back off exponentially with jitter
  (`ORCH_WAIT_BACKOFF_MS`, `ORCH_WAIT_BACKOFF_MAX_MS`); waiting state rewrites the board only when
  the reason changes.
- OpenClaw version-gate diagnostics: the runtime `tui` interface probe runs first; unverified
  versions fail closed carrying the probe result, node-pty presence and the last-verified version.
- `orch-adapt` shim for the adaptation entry.

## 0.6.0 — core 1.11.0

### Added

- Initiating-agent alignment: an adapter-less initiator with a landed profile (Hermes) is a
  first-class auto host — its own CLI becomes the executor, with `--no-restore-cwd` guarding
  against stale-session CWD writes.
- Model/effort inheritance for caller-driven runs, and model/effort traceability in
  `summary.json` (value plus source: explicit / host session / host-default).

## 0.5.0 — core 1.10.0

### Added

- Unit carrier tiering: TUI-class agents run on an invisible ConPTY pseudo-terminal carrier by
  default (a real console, no window, no focus steal); print-class CLIs keep the no-console
  carrier. Identity, lease and recovery contracts are unchanged.

## 0.4.0 — core 1.9.0

### Added

- Caller-driven channel: `--plan-file` (caller-supplied ledger/blocks, zero model calls in the
  run), `--unit-cmd` / `--unit-cmd-file` (bring any CLI without an adapter), read-only `--tasks`
  to align ids first, and resume identity rules for unit commands.
