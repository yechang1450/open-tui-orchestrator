# 安装（中文）

## 环境要求

- **Windows 10/11（x64）**——当前仅支持 Windows：除 `--version`、`--help`、`--install-deps` 外，其它入口在别的平台上都会以一行诊断直接拒绝（不留「半能用」、不静默降级）。
- **Node.js 22 或更高**（`node --version`）。
- **Windows Terminal**（推荐；`--doctor` 会报 `terminal: "wt"`，缺失时回退 `conhost`）。
- **一个已安装并已登录的宿主 agent CLI**：Codex、pi、opencode、Kimi Code、Claude Code、OpenClaw 或 Hermes Agent。编排器只驱动你已有的 CLI，**不会**安装、升级或替换任何 agent CLI。

## 从 npm 安装

```powershell
npm install -g open-tui-orchestrator
open-tui-orchestrator --install-deps          # 拉取本包锁定的 SDK 依赖
open-tui-orchestrator --agent codex --doctor  # 验证
```

`--install-deps` 只安装**本包自己的**锁定依赖——`@lydell/node-pty`（无窗 ConPTY 载体）与 `@openai/codex-sdk`（Codex 宿主运行）——装进已安装的包目录内。只需联网一次；幂等：再跑一次会输出 `{"ok":true,"action":"already-present"}` 且不联网。

## 从 tarball 安装（未上 npm 也能用）

```powershell
npm pack                                       # 在仓库内执行 -> open-tui-orchestrator-<版本>.tgz
npm install -g .\open-tui-orchestrator-<版本>.tgz
open-tui-orchestrator --install-deps
```

## 从源码安装（贡献者）

```powershell
git clone <本仓库>
cd open-tui-orchestrator
npm run setup                                  # = npm ci --prefix scripts
npm test                                       # 离线回归（环境要求见上）
node scripts/gate.mjs --all                    # 机判门禁：套件 + doctor + 反例能红 + 未知 run + 版本·封印·文档口径对账
node scripts/release-integrity.mjs             # 封印校验（跑之前先确认这份检出没被动过）
node cli.mjs --agent codex --doctor
```

## 验证

`--doctor` 输出一段 JSON。健康安装长这样：

```json
{ "agent": "codex", "hostError": null, "carrier": "pty", "carrierAvailable": true, "spawnMode": "headless" }
```

- `hostError: null`——宿主 CLI 解析成功；
- `carrierAvailable: true`——隐藏执行载体就绪（这就是 `--install-deps` 的作用）；
- `spawnMode: "headless"`——单元默认无窗运行，`--mode window` 切可见 TUI 窗。

## 第一次运行

```powershell
orch "刷新登录页文案；给令牌刷新路径补一条回归测试"
```

`orch` 是强制编排入口；常规入口是 `open-tui-orchestrator --run-windows "<请求>"`。真正可并行的请求会按块拉起执行单元——默认 headless、不弹窗。从另一个 shell 只读观察：

```powershell
open-tui-orchestrator --status --readonly
open-tui-orchestrator --watch <runId> [--jsonl]
```

运行状态只落在 `<工作区>\temp\orchestrator\runs\<runId>\`（`manifest.json`、`summary.json`、`acceptance.json`、`attempts/`）。`summary.json` 是逐任务的权威结果账本。

## 升级 / 回滚

安装即「目录级发行副本」：升级或回滚就是替换该目录，然后重跑一次 `--install-deps`。当前版本用 `open-tui-orchestrator --version` 查看（只读，不解析 agent CLI）。

## 卸载

```powershell
npm uninstall -g open-tui-orchestrator
```

各工作区的状态仍在 `<工作区>\temp\orchestrator` 下，需要彻底清干净就手动删。没有后台服务；除包目录外唯一的系统级痕迹是跨工作区共享窗口预算用的协调器定位（`HKCU\Software\TuiOrchestrator`）。

## 排错

| 症状 | 处理 |
| --- | --- |
| `RELEASE_DEPENDENCY_MISSING` | 跑 `open-tui-orchestrator --install-deps` |
| `HOST_UNKNOWN` / `CLI_MISSING` | 安装并登录 `--agent` 指定的 CLI，或用 `ORCH_CLI` 指向其绝对路径 |
| `--watch` 报 `Run not found: <id>` | run id 写错，或该 run 属于另一个 `--workspace` |
| 什么都没弹出来 | 这是默认行为（headless）；`--mode window` 才有可见窗 |
| `--install-deps` 失败 | 它会打印手工兜底命令 `npm ci --prefix "<包>\scripts"`；确认 Node 22+（含 npm）在 PATH 上 |

## 它在你的机器上做什么（简版）

完整声明（包括**没有**沙箱化的部分）见 [docs/trust-and-safety.md](docs/trust-and-safety.md)。简版：

- 只驱动你已有的 agent CLI，并沿用你现有的授权——Codex 在「never 审批 + full access」策略下会带 `--dangerously-bypass-approvals-and-sandbox`，以免已授权的窗口卡在项目信任提示上；
- 运行状态**只写** `<工作区>\temp\orchestrator`；
- 不安装/升级/替换 agent CLI，也不把你的凭据发往任何地方；
- `--unit-cmd` 执行的是**你自己**给的命令：那是调用方自授权，不是提权。
