# Security policy

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** on this repository
(*Security* → *Report a vulnerability*). That opens a private advisory visible only to the
maintainer and you. If you cannot use it, open a regular issue that contains no exploit
details and say you have a security report — a private channel will be arranged.

Please include: affected version (`open-tui-orchestrator --version` prints package + core),
Windows version, the host CLI you drive, a minimal reproduction, and the impact you believe
it has. Do not test against third-party machines or accounts.

## What counts as a security issue here

This tool launches other CLI agents on your machine and runs their work in parallel. The
interesting failure modes are therefore:

- a command or path escaping the workspace the caller supplied (containment of launcher
  files, run state and unit commands);
- the release seal (`release.json`, SHA-256 over the execution core and runtime entrypoints)
  accepting modified or injected files, or a release copy that does not match the source;
- credentials, tokens or host configuration being written to, or copied out of, run state or
  logs;
- anything that turns a caller-supplied plan file or unit command into execution outside the
  documented contract — see `docs/trust-and-safety.md` for what this tool intends to do with
  your machine, and treat a deviation from that document as a defect.

Reports about the *agents you drive* (their own prompts, permissions and model behaviour) are
out of scope here; report those to the respective CLI's project.

## Disclosure

Coordinated disclosure: acknowledgement within 7 days, an assessment (affected versions,
severity, planned fix) within 30 days where the report is actionable, and credit in the
release notes unless you ask otherwise. Fixes ship as a new release copy with a fresh seal;
`docs/release-policy.md` describes the release and rollback procedure.

## Supported versions

Only the newest release copy is supported. `~/.tools/releases/<version>/open-tui-orchestrator`
snapshots are rollback material, not supported versions. Fixes are never backported to an
older copy silently — the seal and the version number always move together.
