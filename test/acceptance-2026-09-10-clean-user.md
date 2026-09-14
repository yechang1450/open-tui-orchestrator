# 验收 B：干净 Windows 用户安装（orch-test）

日期：2026-09-10　结论：**PASS**

## 方法
- 提权创建本地账户 `orch-test`（无任何用户级环境/配置），提权经 UAC 自动放行链路验证可用。
- `repair.mjs --target D:/temp/orch-acceptance-B/install` 生成发行副本（120 文件，exit 0）。
- 共享 Node：复制 `node.exe`（v24.21.0）到 `D:/temp/orch-acceptance-B/bin/`（干净用户不可达 <user> profile 里的 node）。
- 以 **`<machine>\orch-test` 身份**执行 smoke（提权 `Start-Process -Credential`，输出落 `C:\Windows\Temp\orch-smoke-out.txt`，已提权取回副本 `smoke-out-copy.txt`）。

## 结果（全部在 orch-test 身份下取得）
| 检查 | 结果 |
|---|---|
| whoami | `<machine>\orch-test`，USERPROFILE=`C:\Users\orch-test` |
| 共享 node 可用 | `nodeVersion: v24.21.0` |
| 副本封印复验 | `{"schema":2,"coreVersion":"1.7.2","files":32,"runtimeFiles":50}` exit 0 |
| CLI 命令面 | `--help` exit 0（完整 usage） |
| 无 CLI 时行为 | `--status --readonly` / `--doctor` 均 exit 1，`CLI_MISSING: kimi … Tried: no candidate found on disk`（fail-closed，无静默回退，且带 1.7.1 引入的逐候选诊断） |
| 指定 ORCH_CLI 后 | `--doctor` exit 0，JSON 正确显示 agent=kimi / cli=副本路径 / workspace=副本目录 |
| 写权限 | 副本目录可写（`canWriteAcceptanceDir: True`） |
| 代码面无 <user> 硬编码 | `cli.mjs`、`repair.mjs`、`scripts/**` 全部无 `<user>` 字样；`<user>` 仅存于 `test/*-live-result.json` 等历史证据文件（非代码路径） |

## 判定
干净用户在**零用户级配置**下：副本完整性自检通过、命令面可用、缺 CLI 时按契约 fail-closed、提供 CLI 后完整可用。符合验收 B 判据（安装/命令面，未做真窗——真窗需 kimi 凭证，按预案默认不做）。

## 备注
- `--status` 依赖解析发起 agent CLI，干净用户没有 kimi CLI 时按设计 exit 1 + 清晰诊断，不属缺陷。
- 残留清理：账户 `orch-test`、`D:/temp/orch-acceptance-B/bin/node.exe`、标记文件、必要时 profile 目录（收尾统一执行）。
