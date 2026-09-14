# Caller-driven execution (any agent)

open-tui-orchestrator is a system tool: **any agent that can run a shell command can call it.** Nothing below needs a new per-agent adapter — the calling agent supplies the plan and the unit command, and the orchestrator keeps only the deterministic mechanics (validation, grouping, capacity, units/windows, leases, run board, guardian, recovery, acceptance).

## Two switches

```text
--plan-file <plan.json>                              the caller's own ledger / block plan (zero model calls)
--unit-cmd '<json>' | --unit-cmd-file <unit.json>    how one execution unit is launched
```

An explicit unit command overrides host resolution entirely: no process-chain detection, no `--help`/`--version` probe, no allow-list. `--agent <id>` stays optional and only labels the ledger — `--doctor` reports `unit: caller`, `probe: none`.

## 0. Align IDs first (read-only)

```bash
node cli.mjs --tasks "<original request>"
```

prints the authoritative ledger (`T001`, `T002`, …) that a plan file must cover exactly. This entry needs no host identity at all.

## 1. Plan file

One shape per file — either `{"tasks":[…]}`, or `{"blocks":[…]}`.

Tasks-level (a flat classification; the deterministic engine still does all the grouping):

```json
{"schema":1,"tasks":[
  {"id":"T001","project":"81","kind":"project",
   "conflict_hints":["file:src/login.js"],"depends_on":[],"feasible":true,"already_done":false}]}
```

Block-level (same shape as `--plan` output):

```json
{"schema":1,"blocks":[
  {"type":"independent","title":"proj-81","dependsOn":[],
   "conflictKeys":["file:src/login.js"],
   "tasks":[{"id":"t1","prompt":"仅处理项目 proj-81。任务：<original task text, verbatim>；"}]}]}
```

Hard rules (the existing core, unchanged):

- ids must match `--tasks` exactly — a missing, duplicated or invented id is refused;
- every block task prompt must contain its original task text **verbatim**, otherwise the whole plan collapses into one serial `complete-inventory` block (nothing is silently dropped);
- unknown, self-referential and cyclic dependencies are refused;
- capacity compaction and dependency waves apply exactly as with the model planner.

**Zero model calls:** with `--plan-file` the two model stages (planning, read-only classification) and the decompose cache are all skipped. `--plan --plan-file` is a pure dry run that prints the effective blocks.

## 2. Unit command

```json
{"schema":1,"id":"myagent","label":"My Agent","bin":"C:/path/agent.exe",
 "args":["run","--prompt-file","{promptFile}"],
 "promptDelivery":"file",
 "modelArgs":["--model"],"effortArgs":["--effort"]}
```

- `{promptFile}` — absolute path of the prompt file (recommended); `{prompt}` — the prompt as a single argv element; `{workspace}` — the run workspace.
- Exactly one delivery: `file` (needs `{promptFile}`), `arg` (prompt appended as the last element), `stdin` (no prompt placeholder).
- `bin` must be a real executable — Windows cannot spawn `.cmd`/`.bat` directly.
- argv is built element-by-element (`shell:false`); the PowerShell launcher keeps quotes, Chinese and spaces intact.
- No probe, no version assertion: the caller vouches for the command.
- Completion uses the same contract as every host: the unit writes its checkpoints, prints `__ORCH_DONE__ <token>` as its last line, and the parent re-checks the real results with its own acceptance file. Output text is never parsed for success.
- `unitProfile` is stored in the run ledger; `--resume-run` reuses it, and re-supplying a different one is refused.

## 3. Run

```bash
node cli.mjs --plan-file plan.json --unit-cmd-file unit.json \
  --run-id my-run --acceptance-file acceptance.json \
  --run-windows "<the original request>"
```

The original request string is still required — it is the authoritative ledger the plan file has to cover. Default spawn mode is headless; `--mode window` keeps the visible Windows Terminal popups. Acceptance checks (`{T001:[{"type":"file"|"json"|"command"|"absent", …}]}`) are the only proof of success; missing checks leave tasks at `awaiting-verification`.

## 4. Any agent, in four lines

Paste into any agent's global instruction file (`AGENTS.md`, `CLAUDE.md`, …):

```text
## system tool: open-tui-orchestrator (parallel TUI units)
Complex request with ≥2 independent workstreams?  Run:  orch "<request>"   (or open-tui-orchestrator --run-windows "<request>")
No adapter for your CLI? Bring your own:  --plan-file plan.json --unit-cmd-file unit.json   (align ids with --tasks; see docs/caller-driven.md)
Watch:  --status --readonly | --watch <runId>     Result ledger:  <workspace>/temp/orchestrator/runs/<runId>/summary.json
```

## 5. What the caller still owns

- the acceptance checks — a run is successful only when every task is independently verified;
- a plan that covers every task of the request;
- a unit command that can actually do the work (and is authorized in the caller's own context).

## Failure contract (machine callers)

Every public entry fails closed the same way — one line, no Node stack:

```text
[orchestrator] FATAL: Run not found: <id> (no summary.json in <dir>)
```

- data goes to stdout, diagnostics to stderr; a read-only entry's stdout stays pure data;
- exit codes: `0` success · `1` refused/failed (unknown run, tampered acceptance, missing host, verification failed) · `2` usage;
- full stacks are opt-in: `ORCH_DEBUG=1`;
- an unknown run never hangs and never dumps `ENOENT`: `--verify-run` / `--resume-run` refuse immediately, `--watch` allows a bounded grace first (`ORCH_WATCH_GRACE_MS`, default 60000 ms — covering the window in which `--run-windows` is still planning and has not created the run directory), then refuses; a run that loses its `summary.json` mid-watch is reported instead of being watched forever.

## Boundaries

- read-only entries (`--tasks`, `--status`, `--watch`, `--doctor`, `--verify-run`, `--clear-cache`) need no host identity;
- action entries still respect the maintenance lock, and the inline gate still returns single-block / serial plans to the initiating conversation unless `orch` / `--force-exec` is used deliberately;
- an explicit unit command is arbitrary code execution under the caller's existing authorization: the orchestrator forwards permissions and never widens them.

## Verification

```bash
node --test test/caller-driven.test.mjs
```

covers: the `--tasks` ledger, plan-file schemas and coverage fail-closed, the "no model is called" guarantee, unit-profile validation and argv expansion, a full caller-driven run (two parallel units, acceptance verified), resume identity rules, the fail-closed negatives, the two-path diagnostic for unknown agents, and the maintenance lock.
