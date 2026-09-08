# OpenClaw adapter

The generic CLI implements an OpenClaw-specific adapter for the installed OpenClaw 2026.9.2 release on Windows. It does not pass Codex or pi arguments to OpenClaw. Other OpenClaw versions fail explicitly until their configuration, transcript and TUI interfaces are validated.

From the initiating workspace:

```powershell
open-tui-orchestrator --agent openclaw --doctor
open-tui-orchestrator --agent openclaw --plan "Your tasks"
open-tui-orchestrator --agent openclaw --run-id <id> --acceptance-file <absolute-json> --run-windows "Your tasks"
```

The ordinary shared planner, global capacity coordinator, task ledger, independent acceptance and recovery controller remain authoritative. OpenClaw's own concurrency setting cannot increase the memory-derived window capacity.

## Isolation and lifecycle

Each window uses the actual `openclaw tui --local` command inside OpenClaw's installed `@lydell/node-pty` terminal implementation. Its state directory is unique under the initiating workspace's `temp/orchestrator/openclaw`. This avoids the native exclusive-state collision without changing or stopping the user's main gateway.

The adapter binds both the configured agent workspace and terminal cwd to the initiating directory. It supports Windows drive roots by treating recursive mkdir of an already-existing drive root as a no-op; other filesystem errors still propagate.

Existing provider configuration is loaded through OpenClaw's runtime API. A temporary configuration uses current `agents.entries` fields and environment references for credential values. The original configuration is unchanged. Channel delivery, scheduled work, hooks and automatic memory search are disabled for these isolated worker sessions. Existing sandbox and execution-policy settings are preserved. Plugin-imposed approvals are not bypassed; configurations requiring interactive approval are not claimed as unattended-compatible.

Configuration validation runs before interactive startup to prevent a schema migration prompt inside the TUI. Planning uses OpenClaw's `agent exec` with all tools denied. Real execution always uses the TUI.

The window controller reads only its own SQLite transcript. It requires the final assistant message, a successful stop reason and the exact completion token, and rejects user or tool messages. It then sends `/exit` and requires a clean process exit. The completion marker remains separate from the parent's independent task acceptance. A bounded watchdog can terminate its own terminal on timeout; it never terminates the shared gateway.

The parent can adopt a surviving window on `--resume-run` through the existing process-identity contract. Preserve the run's acceptance outputs and checkpoints until recovery and verification are finished.

## Verification commands

```powershell
node <repo>/test/live-openclaw.mjs --smoke
node <repo>/test/live-openclaw.mjs
$env:ORCH_LIVE_AGENT = 'openclaw'
node <repo>/test/live-recovery.mjs
```

The smoke test verifies an actual command, cwd, result content, task checkpoints and automatic shutdown. The capacity test requires eight simultaneous native TUI descendants and eight simultaneously running probes, with the ninth task serialized inside block eight. Results are recorded per run; static CLI discovery is not sufficient evidence of support.

External plugins, credential stores and custom sandbox combinations require their own acceptance. The current local provider setup has been exercised; this is not a claim that every OpenClaw configuration works unattended.

## Verified results (2026-09-06)

- Generic regression: 129/129 passed. Dedicated installed Codex release: 126/126 passed, with matching physical core integrity manifests in source and cache.
- Capacity run `acceptance-2814b49b-2998-4ed8-9c89-270e02da2d84`: eight windows, nine tasks, 17.205 seconds of actual probe overlap. Every native exit was zero and every window had an automatic-close receipt. The core was unchanged throughout the test.
- Recovery run `recovery-2e7bc61d-f094-44db-9647-fd982adb173b`: controller crash followed by adoption of the same window; the first task executed exactly once; the second completed and the window closed automatically.
- Resuming the already-completed capacity run reverified all results without opening new windows.
- Deliberate completion-timeout test: failed with `OPENCLAW_WINDOW_TIMEOUT` and closed its own terminal within 13.676 seconds including startup and graceful-exit allowance. The deadline was intentionally shorter than normal initialization.
- The first capacity run exposed an overly strict whole-message matcher and required four manual test-worker closures. It is recorded as a lifecycle failure, not a successful unattended run. The fix accepts explanatory text only when the last line is the exact token-scoped marker; regression and the subsequent complete live run passed.
- Source and installed Codex test inventories were reconciled. Native watchdog fixtures now wait for a valid PID rather than file existence, avoiding a race with an empty newly-created PID file.

Compact evidence: [openclaw-live-result.json](../test/openclaw-live-result.json). No cross-machine or cross-version acceptance is claimed. Eight simultaneous OpenClaw startups put significant pressure on this 16 GB machine; startup latency remains a measured limitation.

Cleanup of completed OpenClaw test state directories was rejected by host automatic approval review with `host automatic approval review denied cleanup`. Zero directories were removed by that command, no alternate deletion route was attempted, and the test state remains under the initiating workspace's temp directory. Functional TUI execution required no manual user approval.
# 2026-09-06 通道隔离补充

每个测试实例除使用独立状态目录、清空 channels 外，还显式设置 plugins.entries.openclaw-weixin.enabled=false，防止微信插件自行发现账户。主配置不修改，模型供应商插件保留。此项属于隔离加固；未发现此前测试抢占微信登录的证据。

微信主通道验收应检查 accounts 的 connected=true、lifecycle=ready 及持续成功轮询，不能只检查 configured。回复发送仍需单独验收。
