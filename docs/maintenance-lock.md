# Maintenance lock

While the orchestrator itself is being upgraded, optimized, maintained or updated, the installation should not serve orchestration calls: the files an agent would load may be mid-edit. The maintenance lock makes that pause explicit and checkable.

Acquire it before touching the installation, release it when done:

```
node scripts/maintenance-lock.mjs lock --reason "升级 core" [--ttl-minutes N]
node scripts/maintenance-lock.mjs status
node scripts/maintenance-lock.mjs unlock
```

While the lock is held, every action entry point prints exactly one line and exits 0, so the initiating agent skips the orchestrator and executes directly for that round:

```
open-tui-orchestrator正在维护更新，本轮跳过orchestrator直接开始执行
```

Gated entries: `--run-windows`, `--spawn`, `--resume-run`, `--run`/`--exec`, `--plan`, `--selftest-close` (in `scripts/core/orchestrate-sdk.mjs`), `scripts/open-tui-orchestrator-preflight.mjs` (any kind), and `scripts/open-tui-orchestrator-force.mjs --assert/--verify`. Read-only entries (`--status`, `--doctor`, `--verify-run`, `--clear-cache`, `--enable`/`--disable`) keep working; `--status` additionally prints the lock state.

## Properties

- **Global per user, workspace-independent.** Default path `~/.open-tui-orchestrator/maintenance-lock.json`; override with `ORCH_MAINTENANCE_LOCK` (used by tests). Any workspace sees the same lock.
- **Self-expiring.** Default TTL 180 minutes, capped at 24h (`MAX_TTL_MINUTES`). An expired lock is treated as absent and cleaned up on read, so a crashed or forgotten maintenance session never wedges the tool.
- **Fail-open.** A missing, unreadable or corrupt lock file means "not locked". The lock is a courtesy gate, not a security boundary; it must never break the orchestrator.
- **Atomic.** Written via tmp+rename; readers only ever see a complete JSON record or nothing.
- **Advisory self-lock in repair.mjs.** `repair.mjs --clean` and `repair.mjs --target` acquire the lock for their own duration when no lock is held, and never release a lock held by someone else. (`process.exit()` skips `finally`, so each exit point releases explicitly.)
- **Test hook.** All readers/writers accept an `env` parameter; `ORCH_MAINTENANCE_LOCK` isolates tests from the real user-level lock. `test/maintenance-lock.test.mjs` covers acquire/read/release, TTL default and cap, expiry cleanup, corrupt-file fail-open, the CLI, and the gated entries (preflight / force / `--run-windows` / `--spawn` / `--status` bypass).

## Maintenance workflow rule

Any session that will modify the orchestrator installation (upgrade, optimization, repair, republish, seal refresh) runs `lock` first and `unlock` last. If in doubt whether a lock is stale, `status` shows the reason and expiry; `unlock` is always safe.
