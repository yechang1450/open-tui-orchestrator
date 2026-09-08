> Historical assessment before implementation. Current support and acceptance: [OpenClaw adapter](openclaw-adapter.md).

# OpenClaw compatibility and Codex plugin assessment

This is an assessment, not a declaration of OpenClaw adapter support.

## Fresh verification

- Dedicated Codex plugin: `node --test test/*.test.mjs` completed with 124 passes, zero failures and zero skips (37.55 seconds).
- Dedicated plugin status: no active windows, pending reservations or pending locks.
- Installed OpenClaw: 2026.9.2 (3928bad), discovered through the existing npm CLI installation.
- Generic entry: `--agent openclaw --doctor` exits 1 with `ADAPTER_UNSUPPORTED`. The current adapter table implements Codex and pi only; no alternative agent was substituted.
- No OpenClaw orchestration or eight-window acceptance is claimed by this report.

## Connection diagnosis and repair

The existing Windows scheduled task `OpenClaw Gateway` was disabled. Both the gateway probe and `openclaw health` reported ECONNREFUSED at 127.0.0.1:18789. The native gateway start command also explicitly failed because the scheduled task was disabled.

Enabled that existing task and started it through `openclaw gateway start --json`. Health subsequently passed. A fresh gateway status reported the gateway running, configuration audit clean and RPC connected. No credentials, model configuration or approval policy were changed.

A no-tools connectivity request returned exactly `OPENCLAW_READY`, with run ID `296ff2e0-4301-4637-8df2-3d06e50a1cdd`. Delivery was not enabled. The response reported the existing configured workspace `C:\Users\yecha\Desktop\openclaw`, although the invoking shell was in `D:\`.

The evidence establishes why the service could not connect; it does not establish who or what disabled the scheduled task. This failure was local service unavailability, not an observed Internet transport timeout. A generic RPC connectivity probe does not prove every operator capability or external messaging channel is usable.

## Integration constraints

OpenClaw's locally installed CLI documentation and official TUI reference agree that local TUI mode holds exclusive ownership of its state directory. Multiple local windows must not share that directory with each other or the gateway. Gateway-backed TUI sessions avoid that particular ownership collision, but their agent workspace is configured on the gateway; setting only the launcher cwd is insufficient.

The `tui` help exposes initial messages and session selection, but no one-turn exit option. An adapter needs verified assistant completion events and owned-window shutdown, independent task acceptance, interrupted-run recovery and workspace-scoped state. Do not assume the pi shutdown extension works in OpenClaw, or force-close a shared gateway when closing one window.

`agent exec --cwd` does bind both the agent workspace and tool directory and supports isolated transient state. It is explicitly headless, so it cannot be presented as successful real-TUI integration. Plugin approval requirements still apply; no tested universal no-prompt TUI configuration is established here.

Recommended design: a dedicated OpenClaw gateway/session adapter with explicit workspace binding and per-run session identity, followed by single-window lifecycle validation, then the existing eight-window/nine-task and crash-recovery acceptance contract. Preserve the global memory-derived cap of eight regardless of OpenClaw's own configured concurrency (currently 16). Do not repoint the user's existing main agent merely to satisfy a test.

Reference: https://docs.openclaw.ai/cli/tui

## Codex maturity judgment

The current implementation is suitable for supervised use in this tested Windows environment, but is not yet demonstrated to be a broadly stable release. The current tests cover task inventory, capacity, dependencies, leases, process identity, independent acceptance and recovery. Prior real eight-window tests remain historical evidence; they were not repeated in this assessment.

Confirmed release risks:

1. The dedicated source plugin's `scripts/core` is a junction to the generic development core. A generic edit therefore changes the specialized plugin immediately. Release snapshots and rollbackable versions should isolate installed execution from development.
2. The installed skill still contains older Codex-only generic-support wording, contradicted by its newer pi section and the actual adapter table. Documentation needs a consolidated current contract.
3. The current regression suite includes local installation-dependent tests. Passing on this machine does not establish clean-machine installation or cross-version compatibility.

Further reliability evidence should exercise long network interruptions and controller/window crash timing. A pass count alone does not establish those failure modes.

## Follow-up: native TUI and static plugin evaluation

The repeated user request was checked against the current source again:

- Dedicated plugin regression: 124 passed, zero failed, zero skipped, 37.216 seconds. This is a fresh run, not a reuse of the earlier result.
- `plugin-eval start` and `plugin-eval analyze` ran using the installed evaluator. Static score: 72/100, grade C. The two error findings are uppercase letters in the plugin and skill names. Those are evaluator naming checks, not observed execution failures or a measured runtime success rate. No coverage artifact was found by that evaluator.
- The generic `--agent openclaw --run-windows` entry was executed and failed with `ADAPTER_UNSUPPORTED` before opening a window. This verifies the execution entry, in addition to the earlier doctor entry.
- The real installed OpenClaw `tui` was launched in an interactive PTY from `D:\`, using a dedicated session `agent:main:orch-tui-check-20260906`. The initial no-tools request produced the assistant response `ORCH_OPENCLAW_TUI_READY` and the UI reached `connected | idle` with delivery off.
- The TUI remained open after the response. The test controller sent `/exit`; the process exited with code 0. This was a native CLI/TUI smoke test, not an orchestrator-launched desktop-window test, and not automatic completion-marker shutdown.

Current conclusion remains: Codex has meaningful local regression evidence but release maturity gaps; OpenClaw's CLI and native TUI work, while its orchestration adapter is absent. Eight-window execution, workspace-bound tools, independent acceptance and interruption recovery have not been validated for OpenClaw.
