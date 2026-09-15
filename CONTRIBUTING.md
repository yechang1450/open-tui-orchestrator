# Contributing

This is a solo-maintained, Windows-only tool. Issues and pull requests are welcome; the
rules below exist because the release seal and the machine gate depend on them.

## Before you change anything

```bash
node scripts/gate.mjs --all        # the machine gate: L1 suite · L2a doctor · L2b red canary · L3 unknown run · L4 consistency
```

The suite needs the agent CLI it drives to be resolvable (default `codex`); see
*Test-env requirement* in `README.md`. A change is not ready if the gate is red, and a change
that silently weakens a criterion is worse than one that fails it.

## House rules

- **Every new criterion must be able to go red.** Add a test that fails when the behaviour is
  reverted, and say in a comment what would make it fail. `--canary` in the gate exists to keep
  this honest: the criteria are only as good as their worst case.
- **The seal is byte-exact.** Editing any execution-core or runtime file requires
  `node scripts/release-integrity.mjs --seal` and a `CORE_VERSION` bump in
  `scripts/core/contracts.mjs`. The engine refuses to start on a stale seal — that is the
  feature, not an obstacle.
- **Numbers live in one place each and are cross-checked.** `README.md`, `README-zh.md` and
  `docs/release-policy.md` carry the core version, the seal counts and the regression total;
  the gate's L4 fails if any of them drifts from reality.
- **Keep `.ps1` files ASCII-only, LF, BOM-less.** PowerShell 5.1 reads BOM-less files as ANSI
  and embedded-C# helpers break.
- **Failures are contracts.** Callers are programs: a public entry point fails closed with one
  `[orchestrator] FATAL: <reason>` line, no Node stack unless `ORCH_DEBUG=1`, and no silent
  hang. Exit codes: 0 success · 1 refused/failed · 2 usage.
- **Don't invent support.** If a host CLI has not been verified against a version, the tool
  must fail with a diagnostic instead of trying harder. Adapting a new host is a documented
  pipeline (`node scripts/adapt.mjs`, `docs/`), not a guess.
- **Public artifacts carry no machine identity.** No user names, machine names or absolute
  home paths in tracked files; `<user>` / `<machine>` placeholders where a path must be shown.

## Language and style

Code comments and the Chinese README are bilingual where they already are; keep it that way
rather than translating wholesale. Prefer explicit over clever, and state the failure mode you
are protecting against in the comment that implements the guard.

## Reporting instead of patching

Security issues go through `SECURITY.md`, not a public issue. For behaviour questions,
`docs/trust-and-safety.md` is the contract: if the tool does something that page does not
describe, that is a bug worth reporting.
