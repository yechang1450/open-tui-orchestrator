# Changelog

Notable changes, newest first. Every entry pairs a package version with a core version —
`open-tui-orchestrator --version` prints both (`open-tui-orchestrator <version> (core <core>)`).

## 0.9.6 — core 1.14.6

### Fixed

- **A dead model account no longer hides behind a parser-sounding message.** When the classify
  call returned nothing because the account was out of quota (or not logged in, or the network
  failed), the failure line read `no JSON in classify output: (no valid JSON) -> fallback to
  single serial block` — which looks like a parsing bug. `runThreadPrompt`'s `errored`/`warnings`
  (where the real reason lives) were being dropped. The line now carries the underlying reason,
  bounded to one line:

  ```
  before:  decompose LLM failed after 2 attempt(s): no JSON in classify output:  (no valid JSON) -> fallback …
  after:   decompose LLM failed after 2 attempt(s): classify model call failed: You've hit your usage limit. Visit
           https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 19th, 2026 4:10 PM. -> fallback …
  ```

  Verified by before/after on this machine with the same command and the same account state (the
  released 0.9.5 copy versus the fixed tree); the reason text comes from the account, so the run
  also tells you when it recovers. Recorded in `test/acceptance-2026-09-15-windows-guard-live-run.json`.

- Recorded, not fixed (honest boundary): when units themselves fail on quota exhaustion, the run
  correctly reports `success: false` with `failed` tasks and no fake success, but the per-task
  reason is the generic `No durable task checkpoint` / `Safe recovery attempt budget exhausted`;
  the underlying CLI text stays in `runs/<id>/attempts/`. Surfacing the unit-level reason is a
  follow-up, not claimed here.

## 0.9.5 — core 1.14.5

### Fixed

- **The Windows-only promise is now enforced, not just documented.** Measured: with no guard, a
  simulated non-Windows platform reported a *healthy* `--doctor` (exit 0, `"terminal": "wt"`) and
  `--run-windows` proceeded to a real classify call — the front page claimed "other platforms get
  a diagnostic instead of a half-working install", and that claim was false. The refusal now
  happens in `scripts/platform-guard.mjs`, called by `cli.mjs`, `orch.mjs` and the SDK wrapper
  before host resolution, before any model call and before any state: one
  `[orchestrator] FATAL: Windows-only: …` line, exit 1, no stack. `--version`, `--help` and
  `--install-deps` stay available because they are platform-neutral and are what you need when
  debugging a platform issue (they are what the criterion pins as still working).

### Added

- `test/windows-only.test.mjs` — two criteria, red-capable in both directions (remove the guard →
  case 1 fails; widen it to every entry → case 2 fails). The red case was demonstrated for real:
  guard removed from a copy, copy resealed, fake platform → healthy `--doctor`.

### Verified

- A live two-block run against the **released** copy (0.9.4) through the caller-driven channel
  (`--plan-file` + `--unit-cmd-file` + `--acceptance-file`, zero model calls): board reached
  `2/2 verified … finalized success=true`, products `alpha.txt=ALPHA_OK` / `beta.txt=BETA_OK`
  written and hash-recorded, both tasks `verified` with `completed` checkpoints, ~60 s.
- Environment note recorded in the evidence file: the codex account on this machine is out of
  quota until 2026-09-19, so a model-driven run could not be executed today; the orchestrator
  degraded correctly (inline fallback, no fake success) instead of pretending to run.

## 0.9.4 — core 1.14.4

### Added

- **`scripts/gate.mjs` — the machine gate now lives in the repository** and anyone can run it:
  `node scripts/gate.mjs --all` runs L1 the offline regression suite, L2a host resolution,
  L2b a deliberately failing test (proof that the criteria can still go red), L3 the unknown-run
  diagnostic and L4 the version / seal / documentation / suite-total cross-check plus a stale
  mutex-ticket sweep. Every criterion prints command, expectation and actual; a value that cannot
  be read counts as a failure.
- **`.github/workflows/ci.yml`** — the same gate on a clean `windows-latest` runner, including the
  codex install and the `--install-deps` bootstrap self-test. It ships **disarmed** (manual
  trigger only) so that pushing to a private repository never spends Windows runner minutes;
  the header comment names the two lines that arm it.
- **`docs/trust-and-safety.md`** — a plain statement of what this tool does on your machine:
  hidden agents running with your credentials, the Codex approval bypass, what `--unit-cmd` means,
  every file it writes, and the fact that there is no telemetry, daemon or auto-update.
- **`SECURITY.md`** — private vulnerability reporting, scope, disclosure timeline.
- **`CONTRIBUTING.md`** — the house rules (criteria must be able to go red, seal discipline,
  single-source numbers).

### Changed

- README / README-zh lead with the **Windows-only** statement and link the trust statement,
  security policy and contributing guide.
- `INSTALL.md` documents `node scripts/gate.mjs --all`, `node scripts/release-integrity.mjs`
  and `ORCH_NPM_BIN`.

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
