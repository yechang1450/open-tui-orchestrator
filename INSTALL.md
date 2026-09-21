# Install

## Requirements

- **Windows 10/11 (x64)** — Windows-only today: every entry except `--version`, `--help` and `--install-deps` refuses on another platform with one diagnostic line (no half-working install, no silent degradation).
- **Node.js 22 or newer** (`node --version`).
- **Windows Terminal** — recommended; `--doctor` reports `terminal: "wt"` or falls back to `conhost`.
- **One supported agent CLI, already installed and logged in**: Codex, pi, opencode, Kimi Code, Claude Code, or the version-pinned OpenClaw. The orchestrator drives the CLI you already use; it never installs, upgrades or substitutes one.

### Other platforms (Linux / macOS)

The product refuses to run outside Windows by design, and so does its test suite: ~70 of 230 cases
drive the Windows runtime (visible TUI carrier, process snapshot, PowerShell launchers). Running
`npm test` on Linux/macOS therefore stops immediately with one platform diagnostic instead of a wall
of failures. Two escape hatches exist:

```bash
npm run test:portable                  # platform-neutral cases only (path normalization, profile argv)
ORCH_TEST_ALLOW_NON_WINDOWS=1 npm test # run everything anyway; many Windows-only failures expected
```

Platform-neutral behaviour is asserted for POSIX too (a `/d/temp/ws` path must stay untouched on
Linux/macOS; the MSYS/Git-Bash rewrite is asserted on Windows and skipped with a reason elsewhere).

## Install (npm registry)

```powershell
npm install -g open-tui-orchestrator
open-tui-orchestrator --install-deps          # fetch this package's locked SDK dependencies
open-tui-orchestrator --agent codex --doctor  # verify
```

`--install-deps` installs only this package's own locked dependencies — `@lydell/node-pty` (the invisible ConPTY carrier) and `@openai/codex-sdk` (Codex-hosted runs) — into the installed package directory. It needs network access once and is idempotent: a second run prints `{"ok":true,"action":"already-present"}` and does not touch the network. It never installs an agent CLI.

## Install from a tarball (no registry entry needed)

```powershell
npm pack                                       # inside the repository -> open-tui-orchestrator-<version>.tgz
npm install -g .\open-tui-orchestrator-<version>.tgz
open-tui-orchestrator --install-deps
```

## Install from source (contributors)

```powershell
git clone <this repository>
cd open-tui-orchestrator
npm run setup                                  # = npm ci --prefix scripts
npm test                                       # offline regression (see the test-env note in README.md)
node scripts/gate.mjs --all                    # the machine gate: suite + doctor + red canary + unknown run + version/seal/docs cross-check
node scripts/release-integrity.mjs             # seal verify for the checkout you are about to run
node cli.mjs --agent codex --doctor
```

## Verify

`--doctor` prints one JSON block. A healthy install shows:

```json
{ "agent": "codex", "hostError": null, "carrier": "pty", "carrierAvailable": true, "spawnMode": "headless" }
```

- `hostError: null` — the host CLI resolved.
- `carrierAvailable: true` — the hidden execution carrier is ready (this is what `--install-deps` provides).
- `spawnMode: "headless"` — units run invisibly by default; `--mode window` switches to visible TUI windows.

## First run

```powershell
orch "refresh the login page copy; add a regression test for the token refresh path"
```

`orch` is the force-execute entry; `open-tui-orchestrator --run-windows "<request>"` is the regular one. A genuinely parallel request opens one execution unit per block — headless by default, nothing pops up. Watch it read-only from another shell:

```powershell
open-tui-orchestrator --status --readonly
open-tui-orchestrator --watch <runId> [--jsonl]
```

Run state lives under `<workspace>\temp\orchestrator\runs\<runId>\` (`manifest.json`, `summary.json`, `acceptance.json`, `attempts/`). `summary.json` is the authoritative per-task result ledger.

## Upgrade / rollback

Installations are directory-level release copies; an upgrade or rollback replaces that directory and re-runs `--install-deps`. Check what you are running with `open-tui-orchestrator --version` (it prints `open-tui-orchestrator <version> (core <core version>)` read-only, without resolving an agent CLI).

## Uninstall

```powershell
npm uninstall -g open-tui-orchestrator
```

Per-workspace state stays under `<workspace>\temp\orchestrator`; delete it if you want a clean slate. There is no background service and no system-wide state beyond the package directory (a machine-wide coordinator locator is kept in `HKCU\Software\TuiOrchestrator` while runs from several workspaces share one window budget).

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `RELEASE_DEPENDENCY_MISSING` | run `open-tui-orchestrator --install-deps` |
| `HOST_UNKNOWN` / `CLI_MISSING` | install and log in the CLI you pass to `--agent`, or point `ORCH_CLI` at its absolute path |
| `--watch` prints `Run not found: <id>` | wrong run id, or the run belongs to a different `--workspace` |
| Nothing pops up | that is the default (headless); pass `--mode window` |
| `--install-deps` fails | it prints the manual fallback `npm ci --prefix "<pkg>\scripts"`; make sure Node 22+ (with npm) is on PATH, or point `ORCH_NPM_BIN` at your own npm (corporate mirror, alternate install) |

## What it does on your machine (short version)

The full statement, including what is *not* sandboxed, is [docs/trust-and-safety.md](docs/trust-and-safety.md). In short:

- drives the agent CLI you already have and carries your existing permissions — for Codex under the never-approval + full-access policy the launcher passes `--dangerously-bypass-approvals-and-sandbox` so an already-authorized window cannot stall on a project-trust prompt;
- writes run state **only** under `<workspace>\temp\orchestrator`;
- never installs, upgrades or substitutes an agent CLI, and never transmits your credentials anywhere; the only network access it initiates is fetching its own locked dependencies (`--install-deps`);
- `--unit-cmd` runs commands **you** supply: that is your own authorization, not an escalation.
