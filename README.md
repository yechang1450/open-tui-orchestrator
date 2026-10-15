# open-tui-orchestrator

A local Node.js orchestrator for agent CLIs: split a complex request into a lossless, verified task ledger and run its parallel parts in concurrent TUI windows — bounded by the memory your machine can actually spare.

> Project docs: [Contributing](https://github.com/yechang1450/open-tui-orchestrator/blob/master/CONTRIBUTING.md) · [Security](https://github.com/yechang1450/open-tui-orchestrator/blob/master/SECURITY.md) · [Code of Conduct](https://github.com/yechang1450/open-tui-orchestrator/blob/master/CODE_OF_CONDUCT.md) · [Issue templates](https://github.com/yechang1450/open-tui-orchestrator/tree/master/.github/ISSUE_TEMPLATE) · [Pull request template](https://github.com/yechang1450/open-tui-orchestrator/blob/master/.github/pull_request_template.md)

**Windows-only today.** The launchers, the invisible ConPTY carrier and the machine-wide coordinator are Windows-specific; other platforms get a diagnostic instead of a half-working install. Before you run it, read **[docs/trust-and-safety.md](https://github.com/yechang1450/open-tui-orchestrator/blob/master/docs/trust-and-safety.md)** — it states plainly what this tool does on your machine (hidden agents running with your credentials, bypassed approvals for Codex-hosted runs, the exact files it writes). Security reports: [SECURITY.md](https://github.com/yechang1450/open-tui-orchestrator/blob/master/SECURITY.md).

## What it can do

- **Lossless ledger first.** Every request is inventoried into stable IDs (`T001…`) before any analysis; a task is never dropped because a model called it done or infeasible, and a summary never replaces the original wording.
- **Deterministic planning around semantic classification.** A model classifies ownership, resources and dependencies; deterministic code validates coverage, rejects unsafe edges and schedules dependency waves. Missing or malformed model output falls back to a safe serial plan that still covers the full list.
- **Parallel only when it pays.** A fresh run opens windows only for a wave with at least two ready blocks; a single task, a single-block plan and a dependency-only serial chain stay inline in the initiating conversation. Skipping a window never means dropping a task.
- **Memory-fit capacity.** Units default to headless: the same launcher runs under a hidden carrier, so nothing pops up and focus is never stolen (`--mode window` keeps the visible windows). Within one ready wave, heaviest blocks launch first.

```text
per-host unit estimate = p90(observed unit peaks) × 1.3   (falls back to a 640 MB default
                                                           until at least 3 samples exist)
admittable units       = floor((available memory MB − 1000) / unit estimate)
```

`ORCH_MIN_FREE_MEM_MB` sets the reserve floor (default 1000); *available* (not total) memory is used on purpose. Excess tasks merge into serial blocks and remain in the ledger — never deferred to a hidden queue, never removed. A cross-run coordinator confirms active windows; both live windows and starting reservations consume capacity.

- **Evidence, not verbal claims.** Each window prints a complete TODO LIST for its block, writes `started`/`completed` checkpoints and a token-specific `__ORCH_DONE__` marker; a watchdog plus the parent's acceptance checks verify real files, command output, process closure and lease release. The run is green only when every task is `verified`.
- **Recovery without replaying blind.** An interrupted run adopts a surviving window by PID / creation time / executable / command line; a started task whose side effect cannot be proved becomes `needs-reconciliation` instead of being replayed. Stalled units (no evidence movement for `ORCH_UNIT_STALL_MS`, default 600000 ms) are closed and retried inside the block's attempt budget; `ORCH_UNIT_TIMEOUT_MS` (default 2700000 ms) caps one unit's lifetime.
- **Seven hosts, one contract.** Codex, pi, opencode, Kimi Code, Claude Code, OpenClaw and Hermes Agent adapters implement argument construction, session/result reading, completion detection and shutdown behind one shared contract. The host is selected with `--agent`/`ORCH_AGENT`, host environment markers, or detection of the initiating agent from the Windows ancestor process chain. Adapter details: [Claude Code](https://github.com/yechang1450/open-tui-orchestrator/blob/master/docs/claude-adapter.md), [OpenClaw](https://github.com/yechang1450/open-tui-orchestrator/blob/master/docs/openclaw-adapter.md), [pi](https://github.com/yechang1450/open-tui-orchestrator/blob/master/docs/pi-adapter.md). An unknown host, an unvalidated CLI or a missing executable produces a diagnostic — nothing is auto-installed and there is no silent fallback to another agent.

Run state (launchers, locks, results, ledgers) lives under `temp/orchestrator` in the run workspace; your agent keeps its own configuration, sessions and credentials in its normal location. The orchestrator forwards the caller's permissions and never acts as a privilege-escalation layer.

## Install

```powershell
npm install -g open-tui-orchestrator
open-tui-orchestrator --install-deps          # fetch this package's locked SDK dependencies (network, once)
open-tui-orchestrator --agent codex --doctor  # verify: hostError null, carrierAvailable true
```

Requirements: Windows 10/11 (x64), Node.js 22+, Windows Terminal (recommended) and one agent CLI you already use and are logged into — Codex, pi, opencode, Kimi Code, Claude Code, OpenClaw or Hermes Agent. The tool never installs or substitutes an agent CLI. Tarball install, source install, upgrade/rollback, uninstall and troubleshooting: **[INSTALL.md](https://github.com/yechang1450/open-tui-orchestrator/blob/master/INSTALL.md)** (中文: [INSTALL-zh.md](https://github.com/yechang1450/open-tui-orchestrator/blob/master/INSTALL-zh.md)).

## When to use it

Use it for a request that touches several projects or directories, contains independent fixes, or pairs prerequisites with a long verification and cleanup phase. For a small action, a single operation, a purely serial chain or read-only analysis, the current agent is the better execution surface — that work stays in the initiating conversation. `--spawn` is the explicit entry point for one visible window.

## Quick start

Run commands from the workspace that should own the run; do not change into the installation directory. The examples assume `cli.mjs` is in the current command path; replace it with the absolute installation path when needed:

```powershell
node cli.mjs --agent codex --doctor
node cli.mjs --agent codex --workspace 'D:\your-project' --plan 'Fix the login page and optimize the cart'
node cli.mjs --agent codex --workspace 'D:\your-project' --run-windows 'Fix the login page and optimize the cart'
node cli.mjs --tasks 'Fix the login page; optimize the cart'
node cli.mjs --plan-file plan.json --unit-cmd-file unit.json --run-windows 'Fix the login page; optimize the cart'
```

`--plan` only plans; a fresh `--run-windows` opens windows only when a parallel wave exists; `--resume-run <id>` adopts a saved run after an interruption; `--verify-run <id>` rechecks a run without executing tasks; `--status --readonly` reports windows, leases and active-run board rows; `--watch <id> [--jsonl]` streams the run board read-only; and `orch` is the force-execute entry — it runs `--run-windows` with every inline fallback bypassed (except the maintenance lock). `orch "<request>"` really launches units; to only inspect the split, use a read-only entry (`orch --tasks "<request>"` prints the authoritative task ledger, `--doctor` self-checks the host) — those print and return without launching. Any agent can call the orchestrator with no adapter at all: `--plan-file` takes the caller's own ledger/blocks (no orchestrator model calls — both planning stages are skipped) and `--unit-cmd`/`--unit-cmd-file` supplies the unit command — see [docs/caller-driven.md](https://github.com/yechang1450/open-tui-orchestrator/blob/master/docs/caller-driven.md). Onboarding a new print-class CLI: `node scripts/adapt.mjs` — see [docs/adapt.md](https://github.com/yechang1450/open-tui-orchestrator/blob/master/docs/adapt.md). While maintaining the orchestrator itself, `node scripts/maintenance-lock.mjs lock --reason "why"` pauses every action entry point until unlocked — see [docs/maintenance-lock.md](https://github.com/yechang1450/open-tui-orchestrator/blob/master/docs/maintenance-lock.md).

## Why this exists

I'm used to giving an AI agent a lot of work at once — and much of it isn't even in the same project, so it can absolutely run concurrently to get through it faster. It started as `codex-tui-orchestrator`, built on codex. Later, after using pi, opencode, hermes and other agents, the thought was: rather than that, why not one `open-tui-orchestrator` that all of these agents can share. And so there is open-tui-orchestrator.

## Supported hosts

Codex CLI, pi CLI, opencode CLI, Kimi Code CLI, Claude Code CLI, OpenClaw CLI and Hermes Agent have adapters. Run diagnostics with:

```powershell
node cli.mjs --agent codex --doctor
node cli.mjs --agent pi --doctor
node cli.mjs --agent claude --doctor
node cli.mjs --agent openclaw --doctor
node cli.mjs --agent hermes --doctor
```

An unknown host, missing CLI or invalid explicit path fails with a diagnostic.

## Validation status

The current generic core is 0.9.24-1, with 540/540 offline tests passing. In the repository, the release judge is `node scripts/gate.mjs --all` — L1 offline suite, L2 host resolution plus a must-fail canary (the criteria themselves can still go red), L3 clean unknown-run failure, L4 version / seal / docs / suite-total cross-check. Every core or runtime change requires a fresh `release-integrity --seal`. Details and evidence: [docs/release-policy.md](https://github.com/yechang1450/open-tui-orchestrator/blob/master/docs/release-policy.md).
