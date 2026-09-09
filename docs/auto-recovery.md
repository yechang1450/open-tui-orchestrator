# Automatic recovery after an abnormal interruption

Every fresh `--run-windows` run arms a detached **run guardian** (`scripts/core/run-guardian.mjs`, wired through `runner.mjs` and the engine's `guardian` hook). The guardian is a tiny hidden Node process that outlives the controller and watches two things: the controller's process identity and the run ledger (`summary.json`).

When the controller process disappears while the ledger is still unfinalized — host CLI crashed, initiating terminal closed, Node killed — the guardian relaunches `node orchestrate-sdk.mjs --resume-run <runId>` on its own. The resumed controller passes the same ledger validation as a manual resume, adopts still-living windows by identity instead of duplicating them (`adopting live ...`), and drives the remaining tasks to a finalized summary. No user re-invocation is involved.

## Bounds (fail-closed)

- Restart budget: at most `ORCH_GUARDIAN_MAX_RESTARTS` resumes (default 3) with 5s/10s/20s backoff, persisted in `guardian.json` inside the run directory. Exhaustion stops respawning; the run stays manually resumable with `--resume-run`.
- The guardian never resumes past the run deadline (`startedAt + timeoutMs`), never respawns when the process snapshot is unavailable (a blind respawn risks a duplicate controller), and exits as soon as the ledger is finalized — success or failure.
- Run ownership is still serialized by `claimRun`: a crashed controller's claim is pruned by identity, so exactly one controller drives the run at any time, whether resumed by the guardian or by hand.
- Uncertain tasks keep the existing policy: only independently verified or retry-safe tasks are re-executed; anything else stops at `needs-reconciliation` for the initiating conversation to review.
- Resumed runs do not spawn a second guardian; the original guardian keeps watching every engine it started. If the guardian process itself dies, automatic recovery stops (manual `--resume-run` still works).

## Scope limits

- The guardian covers controller loss on a running machine. A full OS reboot kills the guardian too; after a reboot, resume manually with `--resume-run <runId>` — window adoption and task checkpoints still apply.
- `ORCH_GUARDIAN=0` opts out per environment; the offline test suite (`NODE_TEST_CONTEXT`) never starts a guardian.
- Per-launch telemetry lives in the run directory: `guardian.json` (state), `guardian.log` (guardian output), `resumed-engine-<n>.log` (output of each guardian-started controller).

## Verification

Offline coverage in `test/run-guardian.test.mjs` (11 cases: single auto-resume with run identity, restart-budget exhaustion, run-deadline refusal, blind-respawn refusal on snapshot failure, PID-reuse immunity, missing/corrupt state fail-closed, engine-side wiring for fresh runs only, guardian failure never failing the run). Live acceptance in `test/live-guardian.mjs` injects a real controller kill mid-run with a surviving window and asserts the guardian's resume adopts it, the first task executes exactly once, and the run finalizes successfully.
