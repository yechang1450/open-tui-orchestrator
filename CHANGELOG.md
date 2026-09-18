# Changelog

## 2026.9.18 — version scheme switch (calver)

### Changed

- **Version numbering becomes date-based (`2026.9.18`), same mechanics as before.** Package version and `CORE_VERSION` now mirror each other as `YYYY.M.D` (leading zeros are not valid in strict semver, so `09` is written `9`). Everything else about a round is unchanged: dual-track checks in the gate (docs / seal / measured suite total), reseal, release copy + junction, commit + push, npm publish. The 0.9.18 changes (sampler fix + the 0.9.17 memory-fit concurrency) are all included; this entry only records the numbering switch.

## 0.9.18 — core 1.16.5

### Fixed

- **The per-unit memory sampler now actually runs (and the learning loop is live).** Two Windows-specific killers, both found by exact reproduction: (1) spawning the sampler PowerShell with `detached: true` made it die silently before executing a single line (no write, no error, no exit) — the spawn is now a plain child; (2) the tree walk used an unfiltered `Get-CimInstance Win32_Process` snapshot, which stalls under load, and crashed on a null pid in the tree — it now walks children with per-parent filtered queries plus null guards. The sampler also writes a `.start` marker and an `.error` file (and the runner tees its stderr), so a silent failure can never happen again unnoticed. Verified end-to-end: a real orchestration recorded six 68MB peaks for its agent into `unit-memory.json`, so estimates now come from measurements (p90 × safety) instead of the conservative default. The 0.9.17 mechanism itself is unchanged and was already verified; safety behaviour (falling back to the default when no samples exist) stays.

## 0.9.17 — core 1.16.4

### Changed

- **Concurrency is now memory-fit, not a formula (bottom-layer mechanism; zero per-agent special cases).** The old ceiling — `floor(freeMB / 1000) × 2` — assumed every unit costs the same, which is false across hosts (measured spread ≈3–4×), so it under-used memory for light hosts and over-admitted for heavy ones (and could merge blocks the machine could easily have run in parallel). New flow: once the TODO list is split (dependencies/conflicts honoured), the engine estimates each unit's footprint from a generic per-host learning table (p90 of measured peaks × `ORCH_UNIT_MEM_SAFETY=1.3`; below `ORCH_UNIT_MEM_MIN_SAMPLES=3` samples it falls back to the generic default `ORCH_UNIT_MEM_DEFAULT_MB=640`), then merges the most mergeable pair — dependency pair → conflict pair → largest pair — until the all-parallel estimate clears the floor `ORCH_MIN_FREE_MEM_MB=256`, or only one block is left. A block costs `1 + ORCH_UNIT_MEM_BLOCK_GROWTH × (tasks−1)` (default 0.15, clamped below 1 so every merge strictly lowers the estimate — the convergence guarantee). When even a single unit cannot clear the floor the run proceeds anyway with a loud `[mem-fit] WARNING` (work is never blocked by memory).
- **A single fitted block means no parallelism ⇒ no spawn.** The request is handed back inline (`reason: single-block`) per the tool's boundary: orchestrate parallel units, or don't spawn at all. (Forced invocations still spawn.) The old `capacity-below-two-windows` gate is retired; `ORCH_MAX_WINDOWS` remains a ceiling.
- **Per-unit peaks are measured generically and fed back.** The runner attaches one lightweight sampler (`unit-memory-sampler.ps1`) to every unit's process tree — it only needs the unit's root pid, so it is host-agnostic — and records the peak into the machine-level store `<tmp>/orchestrator/unit-memory.json` (override `ORCH_UNIT_MEM_STORE`). Sampling and recording fail open and never affect orchestration; records are deleted after being read, which de-duplicates them naturally. Run logs gain a `[mem-fit]` line, every unit logs `[mem] unit <key> peak=<n>MB`, and `--plan` dry runs report the fitted blocks plus a `memFit` object.
- **Auxiliary (interactive) window admission** now uses the same single-unit fit instead of the retired formula, so no dual track remains.

### Tests

- `test/unit-memory.test.mjs` — 13 red-capable criteria: config defaults/clamps (incl. the empty-string trap), store fail-open + round-trip, estimate (default vs learned p90×safety), merge order (dependency → conflict → largest), floor respect, extreme-collapse honesty (`fits=false`), monotonicity under `g<1`, idempotence, and host-genericity (two hosts, one request, different fits).

## 0.9.16 — core 1.16.3

### Fixed

- **Meta-only sentences are dropped deterministically (0.9.15's prompt rule was not enough).** The 0.9.15 live acceptance re-ran the exact dependency request and the real model *still* minted T003 from "必须按上述顺序执行：项目82的产物依赖项目81的产物。" — a prompt rule alone cannot guarantee this. `requestTasks` (the one splitter every downstream consumer derives from: classify prompt, `bindClassifiedTasks`, `ledgerPlan`) now filters meta-only sentences outright: first segment must match a meta prefix (按上述/以上…顺序|先后|要求|依赖, or 以上任务请依次…) **and** carry no concrete payload (no path/file token, no action or business verb). The inventory is never emptied (an all-meta request keeps its single task). Red-capable criterion: `test/meta-task-filter.test.mjs`.
- **The gate is robust on a busy machine (2026-09-18, user directive: never wait for free RAM).** Two knobs and one honest fallback: `ORCH_GATE_TEST_CONCURRENCY` (default 3; lower ⇒ less memory pressure ⇒ fewer capacity-sensitive reds) and `ORCH_GATE_SUITE_TIMEOUT_MS` (default 900000). When the suite reports reds *with a complete summary*, the gate re-runs each red title's file **in isolation**: all green ⇒ recorded as an environment flake (`[gate] L1 environment flake recorded: …`, observed pass/fail logged; L4's measured total = pass+fail) and L1 passes; any file still red ⇒ real regression, the gate fails. A truncated suite (missing summary, e.g. timeout) can never be flaked green.

## 0.9.15 — core 1.16.2

### Fixed

- **Finished windows are now closed at finalize (measured on the pi battery 2026-09-18).** A successful `--mode window` pi run left its panels on screen: the unit processes and the launcher had exited, but the Windows Terminal window stayed — the only sweep (`sweepLeftoverRunWindows`) ran *before* a run, and its corpse criterion ("the Windows Terminal host has no children at all") never fires while the user keeps any other WT window open (the shared host always has children). The sweep now runs both before the runner **and after it returns**, with a per-unit criterion: a recorded window is closed only when no live process references that unit's unique stem (`win-launch-<stem>.ps1` launcher path or the unit's pi session path) — i.e. the unit is really gone — plus the existing "visible window owned by Windows Terminal" checks. Red-capable criteria: `test/leftover-windows.test.mjs` (stem pairing; the post-run sweep wiring).
- **Pure meta/process sentences no longer become tasks.** Measured in the dependency drill: the sentence "必须按上述顺序执行：项目82的产物依赖项目81的产物" became its own task (and its own block), wasting a unit. The classify prompt now states that meta sentences (constraints without a concrete action or artifact) must be merged into the task they constrain or dropped, never given their own task id.

### Added

- **`[env]` telemetry on the inline paths.** The capacity gate and the policy fallback now emit `env:{platform,node,freeMB,totalMB,capacity}` inside their JSON, so "no windows: capacity below two-windows" carries the machine state that produced it (measured: free RAM swung 0.3–3.2 GB on this box, flipping capacity 1↔4 between probes). Red-capable criterion: `test/inline-env.test.mjs`.
- **Foreground activation retries.** With several windows spawning back-to-back one window was measured ending `foreground=false` while its siblings reached the front (the pi battery's 4-window leg). The activation helper now retries the foreground switch up to 3 times (350 ms settle + 900 ms gap between tries) before falling back to the taskbar flash.

## 0.9.14 — core 1.16.1

### Added

- **Progress deadline for unproductive units (first-checkpoint deadline).** Measured 2026-09-18 in a live Codex `--mode window` run: an interrupted attempt (the user pressed ESC in the TUI) was retried correctly within seconds — the verdict came from the on-disk checkpoints, not from trying to detect the interrupt, which leaves no trace in the session rollout — but the retry then spent its whole turn analysing the prompt and the orchestrator's own sources instead of doing the task, so the task never reached its first (`started`) checkpoint. The watchdog now enforces the contract's own first step: if the attempt's `checkpoints/` directory has not moved past the spawn moment within `ORCH_UNIT_FIRST_CHECKPOINT_MS` (default 300000 ms; `0` disables), the attempt is closed early with an `unproductive: no task checkpoint within Ns …` reason and retried inside the attempt budget. The stall channel is untouched (a silently frozen unit still ends on `ORCH_UNIT_STALL_MS`). Red-capable criterion: `test/unit-stall.test.mjs` ("… trips the first-checkpoint deadline" — a live unit with a ticking session file that never checkpoints).
- **Unproductive units are auto-retried once beyond the plain attempt budget.** When every remaining task still has *no* checkpoint at the budget gate — the unit "talked but did not act" — the runner grants one extra attempt (`ORCH_UNPRODUCTIVE_RETRIES`, default 1; `0` disables) and records `unproductiveRetries` in the ledger; once that allowance is spent the budget exhaustion is reported honestly, exactly as before. Red-capable criterion: `test/transient-retry.test.mjs` ("… never writes ANY checkpoint …" with `maxAttempts: 1`).
- **`[env]` observability lines.** Every run now logs `[env] phase=start|final platform=… node=… free=…MB total=…MB capacity=…`, so environment monitoring (memory headroom and the admission capacity derived from it) is visible in the run's own stdout next to the `[board]` lines.

### Changed

- **Prompt hygiene in the unit body.** The `已独立验收的任务禁止重做：` line is emitted only when there are verified tasks — with an empty list it left a dangling colon that a live model treated as a clue about the harness — and a new hard rule instructs the unit to execute the given commands as-is instead of analysing the prompt's provenance or the orchestrator's implementation (`runner.mjs`).

## 0.9.13 — core 1.16.0

### Added

- **Transient unit failures are absorbed, not reported (auto-detect + auto-retry).** Measured 2026-09-18: in a window-mode resume two units exited with code 1 seconds after launch (a transient shared hiccup — the identical command succeeded moments later), and because a unit that wrote a `started` checkpoint but no terminal one was classified `uncertain`, one block surfaced `needs-reconciliation` to the caller while its sibling recovered on the next attempt. The runner now treats "quick death with a started-only checkpoint" as a transient signature and auto-retries the block once — `ORCH_TRANSIENT_RETRIES` (default 1), `ORCH_TRANSIENT_WINDOW_MS` (default 180000 ms), `ORCH_TRANSIENT_BACKOFF_MS` (default 2500 ms). `"retrySafe": false` vetoes the automatic retry (the escape hatch for non-idempotent work); `"retrySafe": true` keeps its "always safe to re-run" meaning. A failure that ran past the window is never masked. Red-capable criterion: `test/transient-retry.test.mjs` (before the change the run ends `success=false` with `Uncertain tasks`).
- **Power-cut posture: a deterministic bootId, durable state and a boot-time recovery scan.** A real power cut kills everything at once, so the response is boot-time convergence: (1) `atomicJson` now writes `tmp -> fsync -> rename`, and readers treat a missing/unreadable ledger as *unknown*, never "finished"; (2) every run and lease record carries `bootId` (boot time from `os.uptime()`, seconds) and a lease/run-owner from a previous boot is reclaimed even when its PID matches a live process (PIDs are reused across reboots); (3) `scripts/core/reboot-recovery.mjs` + `scripts/recover-stale.mjs` list interrupted runs and (opt-in `--resume`) converge them through the one `--resume-run` path, which is itself interruptible and converging. Red-capable criterion: `test/reboot-recovery.test.mjs`.

### Fixed

- **The Codex network policy no longer clobbers a user-declared provider.** The OpenAI HTTPS policy (`model_provider=orchestrator-openai-https`, ChatGPT auth + no WebSocket probe) used to be injected unconditionally into every Codex launch and into the SDK classify path, overriding a provider configured in the user's `config.toml`. Measured 2026-09-18 while moving Codex onto a DeepSeek provider: the injected provider produced `API key login is required, but ChatGPT is currently being used`. `codexNetworkArgs()` / `codexNetworkConfig()` now gate on the effective provider — `auto` (default) injects only while it is the default OpenAI one, `ORCH_CODEX_NETWORK_POLICY=on|off` forces either way. Red-capable criteria: `test/network-policy.test.mjs` (custom provider ⇒ no injection) and `test/host-cli.test.mjs` (argv identity pinned to the OpenAI path).
- **Resume no longer fails because the machine got busier.** `runWindows` threw `Current memory capacity is below the saved block count` when free memory at resume time dropped below the block count captured at run creation (measured 2026-09-18: created with capacity 4, resume computed 2 → the whole resume was refused, `pi` window power-cut leg). Admission is now clamped to the current capacity and remaining blocks queue in waves; the ledger's block-count upper bound is still validated against total memory, so tampering is still caught.

## 0.9.12 — core 1.15.2

### Fixed

- **A live-but-silent unit no longer waits out the run deadline (and no manual Ctrl-D).** Measured 2026-09-17: with the codex account out of quota the TUI sat on its usage-limit banner for 22+ minutes while the engine kept waiting (default run deadline is 6 h), and the only way out was a manual interrupt. The runner now watches *progress* (checkpoint file, result file, launcher `out`/`pty` logs, host session file — mtimes only, no host-format parsing): no movement for `ORCH_UNIT_STALL_MS` (default 600000 ms) means `stalled: no unit progress for Ns`, the unit is closed through the normal teardown path (descendants killed so the launcher still reaches its own `exit 0`; the launcher itself is never force-killed, which would leave a `[process exited, code 1]` pane), and the block retries inside its attempt budget. `ORCH_UNIT_TIMEOUT_MS` (default 2700000 ms) caps one unit's lifetime; the exhausted-budget reason now carries the last attempt's failure text. Red-capable criterion: `test/unit-stall.test.mjs` (a fake launcher that sleeps for 600 s plus a never-resolving wait hook must end as `stalled`, be closed out and retried — before the change the run hangs).
- **Leftover corpse windows are swept.** After a killed unit or a power cut, Windows Terminal keeps dead-pane windows ("[process exited …]") open. The engine now closes the windows it recorded for this run (`win-*.window.json` handles) when they are still owned by Windows Terminal and that host has no live children — never touching other windows. `leftoverWindowHandles()` is the pure, red-capable criterion (`test/leftover-windows.test.mjs`).


## 0.9.11 — core 1.15.1

### Fixed

- **pi host died on an ambiguous model name.** pi's `settings.json` keeps `defaultProvider` and `defaultModel` apart; the detector only read `defaultModel`, so a bare `--model deepseek-flash` reached a pi install with several authenticated providers for that alias and pi refused with `Model "deepseek-flash" is ambiguous across providers: … Use --provider or provider/model` (exit 1). In `--mode window` the TUI therefore exited immediately and every block was marked failed while the windows themselves popped correctly (measured 2026-09-17, pi 0.85.1). `detectPi` now composes `provider/model` when `defaultProvider` is set and the value is not already qualified, and passes an already-qualified spec through untouched. Red-capable criterion: `test/host-model.test.mjs` (`defaultProvider=opencode-go` + `defaultModel=glm-5.3-flash` must yield `opencode-go/glm-5.3-flash`; before the fix it yields the bare name).


Notable changes, newest first. Every entry pairs a package version with a core version —
`open-tui-orchestrator --version` prints both (`open-tui-orchestrator <version> (core <core>)`).

## 0.9.10 — core 1.15.0

### Added

- **An L1 red now names the failing tests.** Measured 2026-09-17: a gate round went red with one failing case (plus the L4 cross-check cascade) and the name turned out to be *unrecoverable* — L1 printed counts only, and the re-judgement of the same head overwrote both `gate-<head>.log` and `judged-<head>.json`. `scripts/gate.mjs` now extracts the failing tests from the reporter's `✖ failing tests:` section (`suiteReds`, with an inline-marker fallback for interrupted runs; it never fabricates), prints them inside the L1 block, prints one machine line `[gate] suite reds (N): name @ file:line:col | …`, and dumps the full suite output to `temp/gate-suite-<stamp>.log`. `tools/orch-patrol.py` parses that line into the judgement record as `suite_reds` and echoes `PATROL_GATE_RED:` lines when a judgement fails. New red-capable criterion: `test/gate.test.mjs` (the parser must name the red test from a reporter fixture, must stay empty on marker-less and green output; before the change `suiteReds` does not exist ⇒ red). Regression 296/296.

### Fixed

- **`--mode window` now actually shows windows.** Measured 2026-09-17 with a top-level-window probe: the spawned Windows Terminal window was `visible=True showCmd=1(normal)` but was *never activated*, and the launcher helper spent 2.5 s pushing the previous foreground window back to the front — so windows opened *behind* whatever the user was looking at, and two full test rounds produced zero visible popups. The popup criterion (pidf + launcher process alive) reported `popup CONFIRMED` throughout, i.e. it was a false green. Now `inactive-window.ps1` takes `-Activate` (default in window mode): it snapshots top-level windows, waits up to 9 s for the fresh sane one, restores it with `ShowWindow(SW_SHOWNORMAL)`, raises it (topmost → not-topmost) and asks for the foreground, then prints a machine-readable verdict (`ok/hwnd/rect/foreground/raised/minimized`). The engine stores that verdict next to the pidf (`win-<stem>.window.json`), logs it on the spawn line, and `windowGenuinelyPopped` now **requires** `ok:true`, so a window sitting behind other windows can no longer pass as a popup. `ORCH_WINDOW_NOACTIVATE=1` restores the old background behavior. Red-capable criteria: `test/inactive-window.test.mjs` (`-Activate` flag + verdict plumbing, `ok:false`/exit-3 and no-verdict failures, helper stays ASCII+LF+PowerShell-parseable) and the rewritten `windowGenuinelyPopped` case (live launcher with no verdict ⇒ false).

### Changed

- **Window capacity now comes from *available* memory**: `maximum windows = floor(available memory MB ÷ 1000) × 2` (never below 1), replacing `round(nominal GB × 3 ÷ 4)` computed from *total* memory — the old form counted memory other processes already held as spare capacity. Read per decision via `os.freemem()`; README, README-zh and `docs/pi-adapter.md` state the new rule and the regression numbers were updated for it.

## 0.9.9 — core 1.14.9

### Fixed

- **Resume adoption of a surviving unit no longer mis-reads one transient identity-snapshot miss as a dead launcher.** Measured 2026-09-16 with the L5 recovery drill re-run on the headless carrier: after the controller was killed, the guardian's resume engine read the live unit's identity with a *single* process snapshot; when that read missed (a known under-load form), the started-but-unproven task was cascaded into `needs-reconciliation` and the run finalized `success=false` about a second after resume — the drill's second kill hit a dead PID and the "stays unfinalized → guardian visibly exhausts → manual re-supply finalizes" scenario could not reproduce (it had passed on the window carrier, a timing accident of the same cause). On a resumed generation (>1) whose unit has no result file yet, the adoption read now uses the same bounded grace-retry as the spawn read (`identityWithGrace`, the default 10 s / 800 ms poll; if the identity still cannot be read the block falls back to recovery, and the engine stays alive through the grace so a re-kill still has a target): a live unit is adopted (`[resume] adopting live <block>; no duplicate window`) and the run keeps waiting on it. Fresh runs and the result-file-present path keep their single-read legacy semantics (the result is read from `rf` anyway, so identity is not required there), so existing fresh-run criteria are untouched. Acceptance: the drill's fail leg re-run goes rc=0 (`passed=true`, `stayedUnfinalized`/`manualResumeFinalized` both true, salvage rc=0) and the auto leg rc=0 — zero popups on both (WindowsTerminal count 0→0); `gate.mjs --all` PASS, regression 295/295.

## 0.9.8 — core 1.14.8

### Fixed

- **The regression and the gate no longer change with the shell's `ORCH_SPAWN_MODE`.** Measured
  2026-09-16: on a machine whose user-level `ORCH_SPAWN_MODE=window` (kept on purpose so manual runs
  show windows), `gate.mjs --all` went rc=1 and the suite went 289/294 — *and really popped visible
  windows*. Four headless-default assertions (`caller-driven` / `orch-force` / `print-profile` /
  `spawn-mode`) inherited the variable from the shell, `queue-backoff` silently ran on the window
  carrier, and `release-package` flipped green/red with the shell's `ORCH_AGENT` (a published copy's
  `--doctor` only diagnoses the missing SDK when a codex host is requested — `gate.mjs` forces
  `ORCH_AGENT=codex`, a bare suite run inherits the shell). The user-level variable stays; the fix is
  on the consumer side: `scripts/gate.mjs` pins every child to `headless` and reports the initiating
  shell's value (`[gate] shell ORCH_SPAWN_MODE=…; children pinned to headless`), the unit-spawning
  tests (`caller-driven`, `orch-force`, `print-profile`, `queue-backoff`), the `adapt --smoke` block
  acceptance and `tools/orch-level-check.py` pin `headless` explicitly, the spawn-mode default
  assertions strip the variable, the `--mode window` case passes the flag, and `release-package`
  pins `ORCH_AGENT=codex`. Acceptance 2026-09-16: `gate.mjs --all` green with the variable set in the
  shell and again without it, zero popups, logs filed
  (`D:/temp/orch-L5-gate-fix-window-20260916.log`, `D:/temp/orch-L5-gate-fix-novar-20260916.log`).
  New red-capable criterion: `test/gate.test.mjs` (the gate must report the shell value and stay
  green; before the change the line does not exist ⇒ red). Regression 295/295.

## 0.9.7 — core 1.14.7

### Fixed

- **Process-identity failures are now diagnosable.** Measured 2026-09-15: a single
  `Get-CimInstance Win32_Process` call took **79.8 s** on this machine (WMI/CIM degraded under
  load) while the engine's snapshot budget is 15 s — every action entry then failed closed with a
  bare `Cannot verify process identities`, which names neither the elapsed time nor the cause and
  offers no way out. The line now carries the budget, the elapsed time, the cause and the knob:

  ```
  before:  [orchestrator] FATAL: Cannot verify process identities
  after:   [orchestrator] FATAL: Cannot verify process identities: the process snapshot did not
           return within 15000 ms (elapsed 15210 ms; the machine may be under heavy load);
           retry, or raise ORCH_PS_TIMEOUT_MS (budget 15000 ms, cap 120000)
  ```

  `ORCH_PS_TIMEOUT_MS` raises the budget (default 15000 ms, capped at 120000 ms). New red-capable
  tests: `test/snapshot-diagnostics.test.mjs` (a 1 ms budget must fail with the elapsed time and
  the knob named; the env override and the cap are asserted).

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
