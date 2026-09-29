# 验收发现（2026-09-28 · 本机七宿主实测）

> **2026-09-29 更新**：BUG-1 / BUG-2 / BUG-4 已修复并通过门禁回归（`ORCH_GATE: PASS — 5 criteria`，离线套件 345/345）；
> BUG-1 已在 `--mode window` 下复测通过（`success=true`、产物齐、零残窗）。BUG-3 待取向决策，BUG-5 判定为参数取舍（非缺陷）。
> 逐条处置见文末「修复记录」。

本轮在**真实机器上模拟用户操作**，对通用编排器做全面验收：`headless` 与 `--mode window` 两种载体 × 七个宿主。
所有读数独立读回（产物文件、`summary.json`、`attempt.json`、`events.jsonl`、`guardian.log`、窗口 `hwnd`），不采信单元自报。

## 结论摘要（发现轮）

| 宿主 | headless | window (TUI) | 字节级一致？ |
|---|---|---|---|
| pi | PASS | PASS | ✓ |
| opencode | PASS | PASS | ✓ |
| openclaw | PASS | PASS | ✓ |
| claude | fail-closed | fail-closed | ✓（契约跨载体一致） |
| kimi | PASS（重试救回） | 1/2（重试救不回） | ✗ |
| hermes | PASS | **FAIL** | ✗ |
| codex | 目录信任卡死 | **guardian error** | ✗ |

---

## BUG-1 · hermes 在 `--mode window` 下不可用（跨载体不一致）

**症状**：窗口正常弹出（`VISIBLE hwnd=… foreground=true`）、`popup CONFIRMED (pidf+launcher+visible window+hermes child)` 也过了，
但紧接着 `[run] B1 launcher already finished; reading its result without identity binding`，三次尝试全部 `exitCode=1`，
最终 `Safe recovery attempt budget exhausted` → `finalized success=false`。

**关键**：**同一宿主在 `headless` 下 PASS**（Phase 1/2 实测 `success=true`、产物齐）。
差异点：hermes 的 CLI 参数含 `-z`（单发模式）与 `--no-restore-cwd`；其余成功宿主（pi/opencode/openclaw）无此形态。

**复现**：`node cli.mjs --agent hermes --mode window --plan-file <plan> --acceptance-file <acc> --run-windows <req>`

---

## BUG-2 · codex 在 `--mode window` 下 guardian 报 error 且不收口（静默失败 + 资源泄漏）

**症状**：窗口弹出、单元起来、两个内存采样器均启动（`[mem] sampler started pid=11204 / 11892`），
之后无任何输出；`cli.mjs` 以 `exit=1` 结束。

**落盘证据**：
- `guardian.log` 全文仅一行：`[guardian] error runId=w-codex2 restarts=0`
- run 目录里**没有** `events.jsonl`、**没有** `summary.json`
- `guardian.json`: `status: "error"`, `restarts: 0`，`updatedAt - createdAt ≈ 105s`
- 引擎进程（`node orchestrate-sdk.mjs --mode window …`）**在 guardian 判 error 后仍存活**（实测需手工 kill）
- 留下 **1 个 WindowsTerminal 残窗**（实测需手工 `Stop-Process`）

**对比同一宿主 headless**：卡在同样的"目录信任"上，但由 **run deadline** 兜底收口，无孤儿、无残窗。

**复现**：`node cli.mjs --agent codex --cli <codex.exe 完整路径> --mode window --plan-file <plan> --acceptance-file <acc> --run-windows <req>`

---

## BUG-3 · codex 适配器未处理首次运行的"目录信任"确认

**症状**（headless 实测，PTY 载体日志）：

```
> You are in C:\...\ws
  Do you trust the contents of this directory? Working with untrusted contents comes
  with higher risk of prompt injection. Trusting the directory allows project-local
  config, hooks, and exec policies to load.
› 1. Yes, continue
  2. No, quit
  Press enter to continue
```

注意同一屏上方显示 **`permissions: YOLO mode`** ⇒ **YOLO 不豁免目录信任**（两者是独立机制）。
headless 无人应答 ⇒ 两个块干等至 run deadline（实测约 15 分钟）后 `Run deadline exhausted`。

**官方解法（codex 自带，非补丁）**：
- `codex exec [OPTIONS] [PROMPT]` —— 非交互入口（不走 TUI 确认）
- `-c, --config <key=value>` —— 覆盖 `~/.codex/config.toml` 的配置项
- `--dangerously-bypass-approvals-and-sandbox` —— 跳过全部确认提示

**注**：本机 codex 的 OAuth 是有效的（`codex login status` → `Logged in using ChatGPT`），失败与凭据无关。

---

## BUG-4 · guardian 进入 error 路径时不报原因

`guardian.log` 在 error 时只有 `[guardian] error runId=<id> restarts=<n>`，**不含任何原因**；
而同文件在其它路径都有可读原因，例如 `[guardian] exhausted runId=<id> restarts=1`。
用户拿到 `status: "error"` 无法自查，只能翻源码。

---

## BUG-5 · kimi 在 window 模式下的恢复能力弱于 headless

- headless：单元超 300s 无 checkpoint → `unproductive` 判据 → 自动重试 → **第 2 次成功**（`success=true`）
- window：同样判据触发重试，但 **B2 两次都失败**

---

## 已确认非缺陷（避免重复排查）

| 现象 | 结论 |
|---|---|
| `B1 launcher already finished; reading its result without identity binding` | 正常路径（launcher 已退出、改读结果文件） |
| `needs-reconciliation` + `hint: declare {"checks":[…],"retrySafe":true}` | **正确行为**：任务已开始但无成功证明且未声明可重试 ⇒ 不盲目重试 |
| `timeout \| Window capacity/resource wait timed out …` | **正确行为**：容量是**机器级**的（跨工作区共享协调器），文案已明确区分"机器级等待"与"单元失败" |
| `[queue] B2: Waiting for capacity — backing off (wait #n)` | 正常排队（实测有 `acquired after 47 wait(s)` 的收口通知） |
| `--run-windows` 对单块/串行请求返回 `mode: inline` 而不执行 | **设计如此**：只有真正的并行波次才开窗；强制执行用 `--force-exec`（或 `orch` 入口） |
| 无项目号时任务被合为 `linked-ambiguous` 单块 | 设计如此：靠项目号/冲突键判定独立性 |
| `--verify-run` 成功时静默（`rc=0` 无输出） | 设计如此：机器可调用契约（成功不说话、失败才 fail-closed） |
| openclaw 无需配置即可推理 | **它复用了 codex CLI 的 OpenAI OAuth**（`openclaw models` 显示 `Providers w/ OAuth/tokens (1): openai (1)`），并非免费额度 |

---

## 验收基线（本轮实测通过项）

- **门禁**：`ORCH_GATE: PASS — 5 criteria`，离线套件 **343/343**（L1/L2a/L2b/L3/L4 全绿）
- **调用方自助通道**（零模型）：双块真并发（PID 不同、令牌每块唯一）、产物逐字节可验、`summary` 27 键、`--status`/`--watch`/`--verify-run` 均可用
- **恢复契约**：自动接管 7 步全绿（`restarts=1`、`generation 2`、`by: guardian` 用 `--resume-run` 接管）；预算耗尽 9 步全绿（`exhausted` 可见、`stayedUnfinalized`、手动收口成功）
- **验收硬约束**：sha256 不匹配即拒、JSON 字段不符即拒（`expected`/`actual` 均打印）、未登录即 fail-closed、`sha256` 证据落盘
- **维护锁**：上锁期间动作入口只回固定话术且不建 run；损坏锁 fail-open 并清理
- **载体**：headless 零弹窗；window 真弹窗（`hwnd`/`rect`/`zrank`/`foreground` 四证）且测后残窗归 0
- **档位继承**：`model/effort/modelSource` 三态留痕实测正确 —— codex `gpt-6-sol`/max（`codex-config`）、pi `opencode/deepseek-v4.1-flash`/max（`pi-settings`）、kimi 同（`kimi-config`）、opencode 同但 `effort=null`（`opencode-config`）、hermes `deepseek-v4.1-flash`/max（`profile:hermes`）

## 环境约定

- 测试工作目录统一为 **`C:/Users/yecha/workspace/temp/otui-tests/`**（不要用系统临时目录或 scratch）
- 跑全量门禁：`pwsh` + PATH 前置 codex vendor bin（`;` 分隔）+ **不设 `ORCH_CLI`** + 不重定向 stdout + PTY
- 单宿主诊断才用 `ORCH_CLI` 或 `--cli`（`ORCH_CLI` 会强制所有宿主解析为 codex，污染全量套件）

---

## 修复记录（2026-09-29）

| Bug | 处置 | 根因 | 改动 |
|---|---|---|---|
| **1. hermes window 不可用** | ✅ **已修 + 跨载体验证** | **两处字段断链**：① `hermes.json` 画像没声明 `carrier`；② `print-profile.mjs` 返回宿主配置时**漏传 `carrier`** —— 于是 hermes 走无终端载体，`hermes chat --tui` 打印 `hermes-tui: no TTY` 后退出（rc=0），编排器只看到"launcher 已结束" | `agent-profiles/hermes.json` 加 `"carrier":"pty"`；`print-profile.mjs` 返回里加 `carrier: profile.carrier \|\| null` |
| **2. 窗口异常退出不收口** | ✅ 已修 | 引擎入口 `main().catch()` 只打 fatal、**不做任何清理**；配合 BUG-4（guardian 提前 error 退出），异常一次就留下孤儿单元 + 尸体窗 | 入口异常路径先 `sweepLeftoverRunWindows()` 再退出；导出 `__residualCleanup`；**复用既有三条关窗判据，不新增** |
| **3. codex 目录信任** | ⏸️ 待取向决策 | 交互式 TUI 首次必然弹 "Do you trust the contents of this directory?"；已写的 `-c projects.<cwd>.trust_level="trusted"` **拦不住**（官方 `--dangerously-bypass-hook-trust` 管的是 hook trust，不是 directory trust） | **实测 `codex exec`（非交互）完全不弹**；改用它与保留交互 TUI 是产品取舍 |
| **4. guardian error 不报原因** | ✅ **已修 + 判据化** | `load()` 把"文件不存在"与"存在但解析失败"**都吞成 `null`** ⇒ 只能按最坏情况 `finish('error')`，且不带原因 | `load()` 改三态（`ok`/`missing`/`broken`）：missing＝继续等（引擎还在跑）、broken＝带原因 fail-closed；`finish()` 增 `why` 参数；兼容旧桩形态。判据 13/13 绿（新增 2 条） |
| **5. kimi window 恢复弱** | 📋 判定非缺陷 | `ORCH_UNIT_FIRST_CHECKPOINT_MS` **旋钮本就存在**（默认 300s）；kimi 在 window 载体下恰好慢过该线 | 属参数取舍，未改默认值 |

**共同形态**：三个真修项都**不是缺功能，而是既有机制没接上**（画像没声明载体 / 解析漏传字段 / 异常路径没调收口）。设计是完整的，是几处接线漏了。

**验证**：门禁 `ORCH_GATE: PASS — 5 criteria`，离线套件 **345/345**；BUG-1 在 `--mode window` 下复测 `success=true`、B1/B2 各 516/525MB、产物齐、测后残窗 0。改核心文件后已按官方通道 `node scripts/release-integrity.mjs --seal` 重封。

**附带修正**：`claude` CLI 曾因 node 前缀被刷新而丢失（非本次改动所致），装回后 `claude-adapter.test.mjs` 转绿。
