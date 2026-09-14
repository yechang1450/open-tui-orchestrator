# Shared execution contract (core 1.3.1, run protocol 2)

Generic development uses scripts/core. The dedicated Codex plugin now owns a separately verified physical release snapshot; changes are promoted explicitly, not through directory junctions. The generic entry implements Codex, pi and version-pinned OpenClaw adapters; the dedicated plugin accepts Codex only. See pi-adapter.md for Pi-specific CLI, planning, session and shutdown behavior.

## Planning and capacity

Detect memory first: nominal GB = round(memoryGiB * 1024 / 1000); maximum windows = round(nominal GB * 3 / 4). The complete plan contains at most this many blocks. Overflow tasks run serially inside existing blocks; no additional capacity waves. Each block starts as soon as its own prerequisites are verified and a capacity/resource lease is available. A dependent of A does not wait for unrelated B. Reject unknown, self and cyclic dependencies before launching. Merge transitive resource conflicts and preserve dependency order. Windows file locks normalize case, separators and existing junction ancestors, and account for directory containment.

The fresh `--run-windows` path applies a spawn gate after planning. A single block, or a plan whose dependency waves never contain two ready blocks, returns `mode: inline` with the complete original task inventory and does not spawn an execution unit; the initiating agent executes that request in its current conversation. Only a wave with at least two ready blocks enters parallel execution. Units default to headless (the launcher runs under a hidden carrier; `--mode window` switches to visible TUI windows; the mode is fixed in the run ledger and inherited by `--resume-run`). This gate prevents a serial request from being presented as a one-unit parallel run while keeping every original task available to the caller.

The parent persists manifest.json with the original request and T001... task identities before asking the planner. Model already_done/feasible flags never authorize omission. Uncertain model coverage falls back to the complete original inventory in a serial block.

Task parsing preserves ordinary comma continuations and quoted command separators. Deterministic planning uses the same boundaries as the original ledger. Semantic classification must return the original IDs; the parent restores original text by ID before grouping. A paraphrased summary cannot silently collapse otherwise valid parallel work into the coverage fallback.

## Execution and verification

The initiating agent chooses a unique run ID and defines independent acceptance checks before launch. This is automatic parent preparation, not a user approval prompt.

- Execute: node <absolute-entry> --run-id <id> --acceptance-file <absolute-json> --run-windows <request>
- Poll: node <absolute-scripts>/poll-windows.mjs --run-id <id> --require-all-success
- Recheck outputs without rerunning tasks: node <absolute-entry> --verify-run <id> --acceptance-file <absolute-json>
- Recover the saved plan after interruption: node <absolute-entry> --resume-run <id>

Each run owns workspace/temp/orchestrator/runs/<id>/{manifest.json,summary.json,acceptance.json,attempts/}. Every attempt records its exact remaining task IDs and a unique token. The TUI runs the supplied checkpoint command before and immediately after each task. The start record is created exclusively; a duplicate start fails. Poll requires the exact run ID, every planned block, every original task, verified statuses and closed launcher identities. An unrelated or previous run never satisfies this check. Failed prerequisites block dependants and remain in the task ledger. A completion marker or window closure alone is not success. Missing acceptance checks produce awaiting-verification, never a false pass. The parent can supply checks and recheck the same run without another TUI execution.

Acceptance JSON maps T001, T002... to arrays of parent-defined checks. Supported checks:

    {"T001":[{"type":"json","path":"temp/result.json","equals":{"answer":42}}]}

file checks require a regular file and optionally sha256; json checks compare specified top-level values; absent checks confirm deletion. command checks run an explicit executable with an args array, shell disabled, from the initiating workspace; they check exitCode (default 0) and optional stdout. Checks may run repeatedly, so they must be read-only. The parent must choose checks that establish the intended result: file existence alone is insufficient for semantic correctness. Checkpoint tokens identify this execution; they are not a security boundary against an intentionally malicious agent.

## Interruption and recovery

The launcher invokes the CLI once. It preserves failure evidence instead of blindly replaying a whole block. The controller independently rechecks every checkpoint and retries only remaining work, with a bounded attempt count (default two per block per controller) and backoff. Replacement windows use the same planned block and cannot exceed global concurrent capacity; verified tasks are omitted from their prompts.

If a task started but its output cannot be proven, automatic retry requires an explicit parent-defined policy:

    {"T002":{"retrySafe":true,"checks":[{"type":"json","path":"temp/result.json","equals":{"done":true}}]}}

retrySafe means repeating the operation cannot create an unintended duplicate effect; it is not a user approval switch. It defaults to false. Tasks with uncertain effects stay in the ledger as needs-reconciliation, and their dependants do not run. The parent investigates actual state and supplies meaningful verification; it must not mark arbitrary commands retry-safe to force progress. Exactly-once execution of arbitrary external effects cannot be guaranteed without an external idempotency mechanism.

--resume-run reuses the saved task inventory, acceptance checks and original workspace. It never calls the planner again. A live launcher is adopted by PID, creation time, executable and command line; no replacement is opened while it survives. A dead controller's ownership is reclaimed under the coordinator mutex, and a second live controller is rejected. Completed tasks are rechecked; successful finalized runs resume without opening any window. Recovery of protocol-1 runs is not supported; their original explicit acceptance checks can still be used with --verify-run. After a controller crash, the initiating agent invokes --resume-run; there is no background service that restarts controllers automatically.

## Global coordination and process identity

Runs in both tools share a window coordinator across this Windows user session, including different workspaces. The first workspace owns temp/orchestrator/coordinator; HKCU Software/TuiOrchestrator stores only its locator. A Windows named mutex serializes lease changes and is released on crashes. Other workspaces keep their own run outputs in their own temp directories. ORCH_COORDINATOR_DIR is an explicit advanced override; all related callers must use the same value to share the cap.

A lease is held before launch and records owner and launcher identity. Capacity counts pending and active windows across runs. Busy resources wait without dropping tasks. Only resource/dependency waits and pre-existing global occupancy delay execution; overflow tasks never create extra windows. Launcher identity includes PID, creation time, executable name and command line. Close operations recheck identity and kill descendants deepest first; they do not kill the shared Windows Terminal host.

## Runtime policy

Windows inherit the initiating directory; do not derive cwd from a target filename. Orchestrator-owned transient files stay under that workspace/temp. Codex-owned configuration and sessions remain under CODEX_HOME. Approval stays never; there is no manual TUI approval step. When the effective policy is never + danger-full-access, the Codex TUI launcher carries `--dangerously-bypass-approvals-and-sandbox` so the project trust confirmation cannot pause an already-authorized window; restricted sandbox values remain unchanged. Existing external host restrictions still apply. The current Codex adapter uses the existing OpenAI login with HTTPS Responses and disables WebSocket probing. Network loss can still cause HTTPS retries; other model providers require a separately tested adapter policy. Windows PowerShell native argv escaping preserves JSON, quotes, Chinese and paths with spaces.

## Caller-driven execution (any agent)

Host identity is optional. A caller may supply both the plan and the execution surface itself:

- `--plan-file <json>` replaces the model planner with the caller's own ledger or block plan: `{"tasks":[…]}` (flat classification, then the deterministic engine groups it) or `{"blocks":[…]}` (final blocks). The authoritative inventory still comes from `requestTasks(<original request>)`; the plan file must cover its `T001…` ids exactly (the read-only `--tasks` entry prints that ledger), every block task prompt must contain its original task text verbatim or the plan collapses into one serial `complete-inventory` block, and unknown/self/cyclic dependencies are refused. With a plan file the run performs no model calls at all (planner, read-only classification and the decompose cache are skipped), and `--plan --plan-file` is a deterministic dry run.
- `--unit-cmd '<json>'` / `--unit-cmd-file <json>` replaces host resolution with the caller's own unit command (`bin` + `args` template with `{promptFile}`/`{prompt}`/`{workspace}` placeholders, one delivery mode `file|arg|stdin`, optional `modelArgs`/`effortArgs`). No `--help`/`--version` probe and no version assertion is performed — the caller vouches for the command. Execution keeps the identical contract: launcher identity, leases, run board, guardian, recovery, checkpoints, the token marker and the parent's acceptance re-check; the unit's output is never parsed for success.
- The unit profile is persisted in the run ledger; `--resume-run` reuses it and refuses a different one. An unknown agent with neither half fails closed with a diagnostic that names both paths (supply a unit command, or adapt the CLI).

Nothing else changes: capacity, waves, the inline gate, the maintenance lock and the acceptance contract stay exactly as described above.

## Failure contract

The public entries answer failures the same way for every caller: one `[orchestrator] FATAL: <reason>` line on stderr, a non-zero exit code, and no Node stack (stacks only with `ORCH_DEBUG=1`). An unknown run ID never produces a raw `ENOENT` and never hangs: `--verify-run`/`--resume-run` refuse immediately with `Run not found: <id>`, and `--watch` applies a bounded grace (`ORCH_WATCH_GRACE_MS`, default 60000 ms — the run directory may legitimately not exist yet while `--run-windows` is still planning) before refusing; a run that loses its `summary.json` mid-watch is reported rather than watched forever. Exit codes: `0` success, `1` refused/failed, `2` usage.

## Regression commands

Run npm test in the generic repository. Invoke test/live-codex.mjs by absolute path from the desired workspace for the opt-in 8-window/9-task real-model acceptance. ORCH_LIVE_ENTRY can select the Codex-specific scripts/orchestrate-sdk.mjs entry to run the same acceptance contract. Existing historical result files are not evidence for a changed core version; retain newly generated run IDs and summaries.
