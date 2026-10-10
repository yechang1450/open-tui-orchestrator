# What this tool does on your machine (trust statement)

Read this before you run it. It is written to be specific rather than reassuring: every claim
here is checkable in the source, and behaviour that deviates from this page is a defect.

## It launches your own agent CLI — several of them at once

- A run splits your request into blocks and starts one process per block, using the agent CLI
  you already have installed and authenticated (`codex`, `pi`, `opencode`, `kimi`, `hermes`,
  or a CLI you adapt). It never installs an agent, never guesses a replacement
  path, and never silently falls back to a different agent.
- By default those processes are **headless and invisible**: no window, no taskbar entry, no
  focus stealing. `--mode window` restores visible Windows Terminal windows when you want to
  watch. The hidden carrier is a ConPTY pseudo-terminal (for TUI-class agents) or a
  no-console process (for print-class CLIs) — either way it is a real console you cannot see.
- **The agent's own permission model is not raised by this tool, but it is often bypassed for
  convenience**: Codex-hosted runs pass `--dangerously-bypass-approvals-and-sandbox`, which is
  the documented way to run Codex non-interactively. That means the agent will not stop to ask
  you before acting inside the block it was given. Do not point this tool at work you would not
  let an unattended agent do. For other hosts the tool uses that host's own non-interactive
  flags; read them in `scripts/core/agent-profiles/*.json` and `scripts/core/hosts.mjs`.
- `--unit-cmd` / `--unit-cmd-file` let **the caller** supply the exact command that runs per
  block. That is an explicit authorization from you (or from the agent that calls it): the tool
  runs what you named, in your workspace, with your credentials. Treat it exactly like running
  that command yourself.

## Files it writes

- **Per run**: `<workspace>\temp\orchestrator\` — the run directory, plan, per-block receipts,
  `events.jsonl`, window/lease pid files, and the acceptance file you asked for. Deleting this
  directory while nothing is running is safe; it is the tool's whole state.
- **Machine-level coordinator**: one registry value
  `HKCU\Software\TuiOrchestrator\CoordinatorRoot` pointing at the coordinator directory inside
  the **first** initiating workspace's `temp\orchestrator`. It holds the global capacity lease
  file and short-lived mutex tickets so that two orchestrator runs (or two agents) cannot
  overbook the machine. `ORCH_COORDINATOR_DIR` overrides it.
- **Release copies**: implementations live under your user directory
  (`~/.tools/releases/<version>/open-tui-orchestrator`), switched by a junction; the tool does
  not write to `Program Files`, the registry outside the key above, or other users' profiles.
- It does **not** modify your agent CLIs' configuration, credentials or session stores. Setting
  them is out of scope: the tool only reads what it needs to inherit your model/effort choice.

## Network, telemetry, background services

- No telemetry, no analytics, no phone-home, no auto-update, no daemon. When nothing is
  running, nothing of this tool is running.
- The only network access it initiates is installing **its own** locked dependencies
  (`node cli.mjs --install-deps`, `npm ci` against the public registry — the same thing
  `npm install` did) and whatever your agent CLI does on its own behalf. `ORCH_NPM_BIN` points
  that install at your own or your company's npm.
- Your prompts, model settings and the files the agents touch go to **your** agent CLI and its
  model provider under your own account — not to this project.

## Reading before trusting

- `release.json` carries SHA-256 hashes of every execution-core and runtime file; the entry
  points verify them on every start and refuse to run on a mismatch
  (`RELEASE_INTEGRITY_FAILED`). `node scripts/release-integrity.mjs` re-verifies on demand and
  prints the exact counts for the release you have.
- `scripts/gate.mjs` is the machine gate: it runs the offline regression suite, the host
  check, a deliberately failing test (proving the criteria can go red), the unknown-run
  diagnostic, and the version/seal/docs cross-check.
- Removal: delete the release copies and the junction, drop `HKCU\Software\TuiOrchestrator`,
  and delete the workspaces' `temp\orchestrator` directories. Nothing else is left behind.
