# Changelog

## 未发布（本地）

- **验收链假阴性修复**：`collectVerification` 旧实现见 `endedAt` 缺失就整块跳过 ⇒「launcher 未退 → 判 failed → 不写 endedAt → verify 拿不到 → run 假失败」。满载 4 块并发实测（runId `6f7b8f2e-…`，B2 `failed`/无 `endedAt`，而 checkpoint `completed`、`c2.txt` 198 B 已落盘）整 run 报 `success=false`。现在该分支补写 `endedAt` 并当场按盘上证据重算；入口守卫只排除「从未尝试」（无 attempts）的块。回归两条：failed + completed + 产物在 ⇒ verified；同一账本删产物 ⇒ 仍 failed（缺 `endedAt` 不构成免检通道）。
- **门禁 L1 计数补 `cancelled`**：`measuredSuiteTotal` 只算 pass + fail + skipped，而满载机的 per-test timeout 会记入 `ℹ cancelled` ⇒ documented 547 vs measured 542 结构性假红（10-21 空闲轮 cancelled=0 时两者相等）。现四项相加，并把 `cancelled` 并入 `missing` 检测（异常 reporter 缺行仍按 unknown is failure 处理）。**未改文档**：547 是 `ℹ tests` 真值。
- **测试侧写读竞态**：`test/force-window-identity.test.mjs` 只等 `existsSync` 就 `JSON.parse`，而 PowerShell `Set-Content` 先建空文件再落字节 ⇒ 满载下必抛 `Unexpected end of JSON input`（产品路径无恙）。改为等到内容可解析；顺带按实测（`processSnapshot` 单次 2–11 s，一次 `--status` 8.5–14.7 s）放宽 5 处测试预算。
- 判据：recovery + recovery-runtime + orchestrator **93/93**；`gate.test.mjs` **9/9**；`force-window-identity` **4/4**（连续 4 轮）。全量门禁（90 文件）待机器空闲后复跑 —— 满载下 L1 仍会因超时红，属环境不属回归。

## 26.10.19-1 — 自改判定精度修复（独立实测轮）

- **自改判定误拦修复（真缺陷）**：`isOrchestratorSelfMod` 旧实现是「全文出现自指词 × 全文出现修改词」——审计类请求（如「审计 build/80、禁止修改任何文件、禁止调用编排器」）因远距离的 `build`/`修改`/`编排器` 同时命中而被整轮退回（独立实测被拦 2 次），否定句与路径片段也计入；同时反向漏拦「升级 OTUI」类真自改。改为**紧邻窗口判定**：自指词与修改词须落在同一 ≤24 字符窗口内且窗口内无否定词；自指词表补 `OTUI`（独立词）与「编排逻辑」、去裸「编排」。明显「修改/升级 编排器」仍拦（窗依赖被改的 SDK，必须先就地改完）。
- **`--verify-run` 输出**：回一行 JSON（`{"kind":"verify-run","runId":"…","success":…}`）——此前只设退出码、无 stdout，机器调用方拿不到读数。
- **文档**（`docs/caller-driven.md`）：task id 由请求顺序生成（`T001…T00N`，不可自取）；模型/effort 继承是 **profile 级**（附 `ORCH_MODEL`/`ORCH_EFFORT` 钉法）；`--verify-run` 的 stdout 契约。
- 判据：**544/544**（+7 用例，含独立实测报告原语料中英文）；`gate --all` 五判据全绿。

## 26.10.18-1 — 六宿主双形态验收 + 动态容量

- **`orch` 只读入口透传**：`--tasks` / `--status` / `--doctor` 等只读入口不再被强制发车（此前 `orch --tasks` 会静默启动一轮真执行）；执行类入口仍强制发车。
- **`ordered` 判据治本**：第九块只等「一个被释放的槽位」（前八块中最早完成者），且重试块以其**首次 attempt 结束**为释放时刻（此前会被最终 finish 拉后而误红）；无 firstFinished 的数据保持旧严格读法（fail-closed）。
- **起窗节奏默认 5000ms**：`ORCH_WINDOW_STAGGER_MS` 从 0（九块同起）改为默认 5000ms——同起两轮实测全红（八窗全卡欢迎页 / `Reservation expired`），错峰后两轮全绿；`runWindows` 的显式参数语义不变（库调用不会被默认值拖慢）。
- **gate L4 计数口径**：实测总数 = `pass + fail + 具名合法 skip`（node 报告的 `ℹ tests` 真值）——宿主未安装的机器不再假红。
- **六宿主双形态验收**：headless+exec（产品默认形态）6/6 全绿；窗口容量腿 6/6 理想轮（codex / pi / opencode / kimi / claude / hermes，全部 `passed=true`、peak=8、9 启动器）。
- **动态容量实测**：24 个独立块 → 引擎按实时内存自算（学习值 1021MB、floor 1000MB）合并为 12 块 → 12 窗并发 → 24/24 产物、12/12 verified；学习表回写后估算下调（1021→837MB），下次同一内存下容量自动变大。
- **`--status` 只读入口提速（发布前实测出的真缺陷）**：`showStatus` 此前对每个历史窗口各取一次全表 WMI 快照（N 个窗口 → 2N 次查询），历史窗口积累后实测 **26s**，超过测试的 20s 上限判红；改为**一次快照供所有窗口复用**（26s → 5s）。同时只读入口（`--status`/`--doctor`/`--watch`/`--verify-run`/`--version`/`--help`/`--clear-cache`/`--install-deps`）不再做宿主模型/effort 继承——该继承要扫宿主会话记录（codex sessions 可达 GB 级），只读入口不需要。
- 判据：**543/543**；`gate --all` 五判据全绿。

## 26.10.14-1 — 画像强化：版本地板 + 规划超时预算

- **画像新增两个可选字段**：`minVersion`（任意 major 的数字三段版本地板——解析版本低于它一律拒绝并给 below floor 诊断；版本串不可比较时不判死、缺省放行）与 `plannerTimeoutMs`（规划等待预算——优先级 env `ORCH_DECOMPOSE_TIMEOUT_MS` > 画像值 > 240000 缺省；只覆盖规划器等待）。
- **大流程定稿**：release-policy 的「大流程」升级为 10 步分步执行单（基线隔离 → 测试版开发 → 全方位测试 L1–L5 → push beta → 合流 → 复测 → master → npm 发布七步 → 发布后验证 → 记录）＋ npm 页快照机制说明（用户面文档改动须经一次发布才反映到 npm 页）。
- 发布前实测：离线套件 **537/537**（＋6 判据：地板 3 + 超时 3；0 跳过）；`gate --all` 五判据全绿；`release-integrity` rc=0；真机轮 codex + hermes 双绿（每轮 RUN_RC=0 + 复核 rc=0、双任务内容级核验）。

## 26.10.13-4 — 公开面瘦身 + 安全审计

- **npm 包极限瘦身**：发布包只保留运行闭包与用户文档（98→66 文件、打包体积 −45%）；仅维护者用的开发文件（gate/force/preflight/todo-list/测试 shim 等）与 `repair.mjs`、`docs/`、`CHANGELOG.md` 不再进包、只存在于仓库；封印面与装机面同构（`orch.mjs` 首次纳入封印）。
- **GitHub 仓安全加固**：secret scanning、push protection、dependabot 告警开启；修复 `SECURITY.md` / `docs/trust-and-safety.md` 中已废弃的发布副本（`~/.tools` + junction）描述；退役已废的 junction 切换工具；patrol 安装器迁移为自定位（不再引用旧布局）。
- **攻击面复核与加固**：复核既有安全基线全项仍成立；修复 `locateCli` 的裸名 `where.exe` 解析 → SystemRoot 锚定（附可红判据：cwd 劫持件必须不被执行）。
- 发布前实测：离线套件 531/531；`gate --all` 五判据全绿；tarball 装机 + 真机轮复验。

## 26.10.13-3 — 七宿主正式版（master 合流）

- **正式版线推进**：`beta` 测试版线一次性合入 `master`（合并提交，`--no-ff`；合并后树与通过双通道验收的 beta 树逐字节一致），七宿主（Codex、pi、opencode、Kimi Code、Claude Code、OpenClaw、Hermes Agent）进入正式版。
- **合并后全量验证**：`release-integrity` rc=0；`gate --all` 五判据全绿（L1 533/533）；七宿主本地形态真机轮 7/7 全绿（每轮 RUN_RC=0 + 复核 rc=0、双任务内容级核验）。
- **内含**：Claude Code 适配器复活；OpenClaw 重建为 print 类（官方 `agent --local` 面）；封印 CRLF 缺陷修复（重封前对账「工作区字节 vs 提交 blob」）。
- 发布：npm `latest` 显式刷新为 `26.10.13-3`；`beta` 通道保持 `26.10.13-2` 不动。

## 26.10.13-2 — beta 测试版（七宿主）

- **修复（GitHub 源安装循环实逮）**：`scripts/package.json` / `scripts/package-lock.json` 的工作区字节曾是 CRLF（提交 blob 为 LF）——封印把 CRLF 字节烘进 runtime 哈希：npm 包自洽，但全新 clone 的 `release-integrity` 必红（`runtime differs`）。已把两文件归一化为 LF 并重封。
- **Claude Code 与 OpenClaw 适配器回归/重建**：claude 按原 print 类设计复活；openclaw 弃用旧 TUI+sqlite 重耦合形态，改驱动官方无头单发面 `agent --local`（接口探针 + 包身份 fail-closed；`OPENCLAW_STATE_DIR`/`OPENCLAW_CONFIG_PATH` 环境隔离；JSON 信封解析；token 化 result 契约）。两适配器共用既有启动器/租约/恢复/验收契约，无宿主专属机制。
- **七宿主一套契约**：Codex、pi、opencode、Kimi Code、Claude Code、OpenClaw、Hermes Agent；doctor 逐家实读 hostError=null / carrierAvailable=true；七宿主真机轮（安装副本）全部 success=true、2/2 verified。
- **发布前实测**：离线套件 533/533（0 跳过）；封印重算 `schema 2 / 45 核心 + 69 运行时`。
- 本版在 `beta` 分支开发，npm 通道 `beta`；master 不受影响，验收后一次性合回。

## 26.10.12 — 外来 pi result 防护 + 公开面清理

- **pi 外来 result 不再可能冒充完成（审计 ID37）**：`writePiLauncher` 的启动前清场是唯一防线——一旦清场失败、或同 stem 的历史 attempt 残留了别的 result，等待端会把它的 `__EXIT__` 当成本单元的完成。现在等待端核对 result 携带的完成 token 与本单元 token 一致才认，不一致一律 fail-closed（`Pi foreign result rejected (token mismatch)`）；不带 token 的 result 保持旧行为。可红判据：`test/pi-runtime.test.mjs`。
- **公开面无私有项目引用**：README（中英）快速开始、适配器文档、CHANGELOG 历史条目、工具与测试夹具不再出现作者私有项目编号；示例统一改中性占位（文本用 项目A/项目B，需要数字编号的位置用 07/08）；classify 提示词去掉固定编号示例；相关验收记录同步清理。
- 发布前实测：离线套件 513/513（3 条按平台跳过——本机未安装的 kimi/opencode/pi CLI）；`gate --all` 五判据全绿；封印 `schema 2 / 41 核心 + 65 运行时`（本轮重封）。

## 26.10.11 — 五 CLI 真机轮 + 恢复/画像增强

- **恢复第三档（unproven）**：跑过、无成果、未声明可重跑的单元自动补跑一次（`ORCH_UNPROVEN_RETRIES` 默认 1、0=关），仍无果时以 needs-reconciliation 诚实上报（恰一次）；`retrySafe:false` 保留否决权。
- **窗口生命周期收口**：正常/异常一律关窗（温柔关三层：杀单元后代 → 等 launcher 自退 → WM_CLOSE → 强杀记账）；异常退出码只记录不判断。
- **画像探测增强**：ANSI 剥离 + 宽列注入；npm shim 自动解析与通用安装位探测；子命令二级探测（`args.subcommand`）。
- **kimi 适配修复**：接受 npm 全局安装的 `.cmd` shim（无 `kimi.exe` 伴生时直接采用；此前误报 CLI_MISSING）。
- **发布前实测**：五家 CLI（codex / hermes / pi / opencode / kimi）同一真实任务端到端全绿（三文件 + `node --test` 通过）；离线套件 511/511；`gate --all` 分层全绿（L1/L2a/L2b/L3 + L4）；封印 `0.9.24-1` / files=41 / runtime=65。

## 0.9.24-1 — 公开入口 fail-closed 收口（正式版号推进）

- 版本号推进至 `0.9.24-1`（带预发布段，npm 需 `--tag latest` 显式刷新）。
- 内容＝0.9.22-2 的全部收口：`--install-deps`/`--help` 先于运行上下文解析（坏 `ORCH_STATE_DIR` 不再吃掉自救入口）；`resolveRuntimeContext` 异常、`--workspace` 非目录、子进程 spawn ENOENT 统一走单行 `[orchestrator] FATAL: <原因>`（`ORCH_DEBUG=1` 才附栈帧，坏工作区点名路径）；`leases.readState` fail-closed（只有 ENOENT 视为首次运行，截断/半写/非 JSON 点名文件）；验收契约 `ACCEPTANCE_UNREADABLE` / `ACCEPTANCE_INVALID` 点名；plan 文件元素级校验（null 元素/类型错字段点名拒绝）；`loadJson` 区分「文件未生成」与「路径中间节不是目录」的 ENOENT。
- 发布前实测：离线套件 **370/370**、`node scripts/gate.mjs --all` **PASS — 5 criteria**、封印 `schema 2 / 47 核心 + 71 运行时`。

## 0.9.22-2 — 公开入口 fail-closed 收口 + 边界鲁棒性回归

- **CLI 失败契约贯通**（`cli.mjs`）：`--install-deps`/`--help` 先于运行上下文解析（坏 `ORCH_STATE_DIR` 不再吃掉自救入口）；`resolveRuntimeContext` 异常、`--workspace` 指向非目录、子进程 `spawn ENOENT` 一律走单行 `[orchestrator] FATAL: <原因>`（`ORCH_DEBUG=1` 才附栈帧），坏工作区会点名路径。
- **状态/账本读取 fail-closed**（`scripts/core/leases.mjs`）：新增 `readState()`——只有 ENOENT 视为首次运行，截断/半写/非 JSON 点名文件报错；`leases.json` 与 `run-owners.json` 全面接入。
- **验收契约错误点名**（`scripts/core/runner.mjs`）：`loadChecks()` 对不可读/畸形文件回 `ACCEPTANCE_UNREADABLE` / `ACCEPTANCE_INVALID: <file>`，并兼容 BOM。
- **plan 文件元素级校验 + 注册表读取歧义治理**（`scripts/core/orchestrate-sdk.mjs`）：`blocks`/`tasks` 元素结构逐项校验（null 元素、类型错字段点名拒绝，不再被静默吃下）；`loadJson` 区分「文件未生成」与「路径中间节不是目录」的 ENOENT，后者不再被当成首次运行回空注册表。
- **回归**：新增 `test/boundaries-robustness.test.mjs`；离线套件 **370/370** 全绿，`cli-surface` / `publication` / `release-package` 用例同步更新；README / README-zh / release-policy 版本与计数口径同步，封印随 `release-integrity --seal` 重签为 0.9.22-2。

## 0.9.22-1 — 套件全绿 + 真机闭环 + 版本号回到 0.9.x

- **版本号**：包版本与 `CORE_VERSION` 同步从日期制 `2026.9.19-5` 回到 `0.9.22-1`（两处镜像，gate 的双轨校验一并更新：README / README-zh / release-policy 的"当前版本"行）。
- **内容**＝本日 6 个修复提交的全量：协调器互斥机制缺陷（满载假红 / 干等盲区 / 锁内全表快照，外加 `ORCH_MUTEX_HOLD_MAX_MS` 与状态票真因）、LLM 拆块静默降级（`plannerPrompt` 悬空变量 `maxWindows` → 并行能力整段失效）、测试隔离（`ORCH_COORDINATOR_DIR` 显式钉住，不再共用机器级槽位池）、退出判定（"读不到快照"不再当成"进程还在"）、采样器（裸 pid 判活 + stdio 管道把整条用例读成超时 → stderr 落文件 + 进程树按启动时刻锚定）、CLI 全覆盖（机器可读入口 stdout 纯数据、未知入口 fail-closed、无会话分支补首检查点期限）。
- **实测**：离线回归 **361/361**、`gate --all` **PASS（5 判据）**、真机四场景（双任务并行 / 可见窗未受信任 / 强杀续跑 / 容量上限与超限）证据见 `test/round3-live-result.json`。


## 2026.9.19-5 — multi-window friendly fire: root-caused and fixed

- The window watchdog matched `__ORCH_DONE__` and the block token with two separate Contains() — an agent printing a shared file (manifest.json carries every token) satisfied both on ONE line for a FOREIGN token, so the first four-window run killed three of its own siblings. Completion now requires the contiguous form `__ORCH_DONE__ <own token>`. Verified: 4/4 windows survive, verify rc=0.
- The per-teardown leftover sweep is scoped to the finished unitu2019s own window stem (a full-TMP sweep could close live sibling windows).


## 2026.9.19-4 — codex window root fixes (long-standing exit-1 mystery solved)

- **Root cause found and fixed**: the window watchdog accepted any assistant message containing the block token *and the word 完成* as a completion report — the task prompt itself satisfies both, so the first in-progress message killed its own window (random victim among concurrent windows, 8-25s deaths, empty checkpoints). Completion now requires the `__ORCH_DONE__` marker or a structured task_complete event only.
- Fixed my own regression: a C-style comment inside the launcher body is not PowerShell syntax and crashed every window at parse time; comment moved to the JS layer.
- Leftover windows (WT keeps non-zero panes) are now swept after **every unit teardown**, not only at the next run start.
- New red-capable guards: no word-heuristic regression, no stray C-style comments in the launcher body (suite 341/341).


## 2026.9.19-3 — actionable queue-timeout message

- The window-slot wait now reports its last reason, elapsed time and next steps when it times out (machine-level contention, not a unit failure); queue waits already log [queue] lines. Semantics verified: waiting on `capacity`/`conflict` is correct and must never be "degraded" into unsafe parallel writing.


## 2026.9.19-2 — window-entry criteria + docs totals

- Adds red-capable tests for the window entry path (mode plumbing), MSYS-style path normalization, and the hermes profile window declaration (suite total 339/339).
- Release chain publishes `-N` versions with an explicit `--tag latest` (no manual rescue needed).


## 2026.9.19-1 — first use of the per-day counter scheme (docs-only)

- No code change vs 2026.9.20 (the fully verified build): this release carries the version-scheme documentation (`YYYY.M.D-N`, N = the Nth change of that day, auto-incremented) and the auto-numbering tool. Publishing `-N` versions uses an explicit `--tag latest` so installs are unchanged.


## 2026.9.20 — real TUI windows for profiled hosts (color + close-on-acceptance + queue visibility)

- hermes window mode now renders the real interactive TUI (chat --tui --yolo --no-restore-cwd -q) in a Windows Terminal at the project directory; the launcher runs the CLI bare so ANSI colors survive; disk-verified acceptance is the settle condition ("close on acceptance"), so no self-exit and no stdout capture are needed.
- Window-slot waits log [queue] lines; the release-criterion version assertion reads CORE_VERSION (no per-release test edits).
- Calver rule: same-day re-releases advance the date number.


## 2026.9.19 — hermes TUI window leg + hygiene

### Added

- **hermes interactive TUI windows ("close on acceptance").** The hermes profile gains a window entry (`hermes chat --tui --yolo --no-restore-cwd -q "<prompt>"`) and the run path picks it from the spawn mode (`ORCH_SPAWN_MODE=window`; the default headless path is unchanged word-for-word). Because a TUI window never exits on its own, the runner now treats a **disk-verified acceptance** as a legitimate settle condition for those units (polling the block's verification every 10 s; on success the unit settles and the window is closed in the existing teardown, which also keeps the post-run sweep clean). Live acceptance: two real hermes TUI windows spawned `VISIBLE`, `2/2 verified`, `success=true`, `verify rc=0`, artifacts correct, **zero leftover windows**.

### Fixed

- The release criterion's version assertion now reads the core constant instead of a hard-coded string (version bumps no longer require editing the test).
- Per-unit peak records fall back to a real label (`options.agent || sum.agent || 'caller'`) instead of writing `unknown` rows into the learning table.

### Note

- Version numbers are release dates with a per-day change counter: `YYYY.M.D-N`, where N = the Nth change of that day, auto-incremented, unbounded (e.g. `2026.9.19-1`, `2026.9.19-2`, …). npm treats `-N` as a prerelease, so publishing uses an explicit `--tag latest`; plain `YYYY.M.D` is the legal form for a day with no counter suffix. Never use four-segment forms like `2026.9.19.1` — they are invalid semver and npm silently rewrites them to a wrong date.

## 2026.9.18 — version scheme switch (calver)

### Changed

- **Version numbering becomes date-based (`2026.9.18`), same mechanics as before.** Package version and `CORE_VERSION` now mirror each other as `YYYY.M.D` (leading zeros are not valid in strict semver, so `09` is written `9`). Everything else about a round is unchanged: dual-track checks in the gate (docs / seal / measured suite total), reseal, release copy + junction, commit + push, npm publish. The 0.9.18 changes (sampler fix + the 0.9.17 memory-fit concurrency) are all included; this entry only records the numbering switch.

## 0.9.18 — core 1.16.5

### Fixed

- **The per-unit memory sampler now actually runs (and the learning loop is live).** Two Windows-specific killers, both found by exact reproduction: (1) spawning the sampler PowerShell with `detached: true` made it die silently before executing a single line (no write, no error, no exit) — the spawn is now a plain child; (2) the tree walk used an unfiltered `Get-CimInstance Win32_Process` snapshot, which stalls under load, and crashed on a null pid in the tree — it now walks children with per-parent filtered queries plus null guards. The sampler also writes a `.start` marker and an `.error` file (and the runner tees its stderr), so a silent failure can never happen again unnoticed. Verified end-to-end: a real orchestration recorded six 68MB peaks for its agent into `unit-memory.json`, so estimates now come from measurements (p90 × safety) instead of the conservative default. The 0.9.17 mechanism itself is unchanged and was already verified; safety behaviour (falling back to the default when no samples exist) stays.

## 0.9.17 — core 1.16.4

### Changed

- **Concurrency is now memory-fit, not a formula (bottom-layer mechanism; zero per-agent special cases).** The old ceiling — `floor(freeMB / 1000) × 2` — assumed every unit costs the same, which is false across hosts (measured spread ≈3–4×), so it under-used memory for light hosts and over-admitted for heavy ones (and could merge blocks the machine could easily have run in parallel). New flow: once the TODO list is split (dependencies/conflicts honoured), the engine estimates each unit's footprint from a generic per-host learning table (p90 of measured peaks × `ORCH_UNIT_MEM_SAFETY=1.3`; below `ORCH_UNIT_MEM_MIN_SAMPLES=3` samples it falls back to the generic default `ORCH_UNIT_MEM_DEFAULT_MB=640`), then merges the most mergeable pair — dependency pair → conflict pair → largest pair — until the all-parallel estimate clears the floor `ORCH_MIN_FREE_MEM_MB=256`, or only one block is left. A block costs `1 + ORCH_UNIT_MEM_BLOCK_GROWTH × (tasks−1)` (default 0.15, clamped below 1 so every merge strictly lowers the estimate — the convergence guarantee). When even a single unit cannot clear the floor the run proceeds anyway with a loud `[mem-fit] WARNING` (work is never blocked by memory).
- **A single fitted block means no parallelism ⇒ no spawn.** The request is handed back inline (`reason: single-block`) per the tool's boundary: orchestrate parallel units, or don't spawn at all. (Forced invocations still spawn.) The old `capacity-below-two-windows` gate is retired; `ORCH_MAX_WINDOWS` remains a ceiling.
- **Per-unit peaks are measured generically and fed back.** The runner attaches one lightweight sampler (`unit-memory-sampler.ps1`) to every unit's process tree — it only needs the unit's root pid, so it is host-agnostic — and records the peak into the machine-level store `<tmp>/orchestrator/unit-memory.json` (override `ORCH_UNIT_MEM_STORE`). Sampling and recording fail open and never affect orchestration; records are deleted after being read, which de-duplicates them naturally. Run logs gain a `[mem-fit]` line, every unit logs `[mem] unit <key> peak=<n>MB`, and `--plan` dry runs report the fitted blocks plus a `memFit` object.
- **Auxiliary (interactive) window admission** now uses the same single-unit fit instead of the retired formula, so no dual track remains.

### Tests

- `test/unit-memory.test.mjs` — 13 red-capable criteria: config defaults/clamps (incl. the empty-string trap), store fail-open + round-trip, estimate (default vs learned p90×safety), merge order (dependency → conflict → largest), floor respect, extreme-collapse honesty (`fits=false`), monotonicity under `g<1`, idempotence, and host-genericity (two hosts, one request, different fits).

## 0.9.16 — core 1.16.3

### Fixed

- **Meta-only sentences are dropped deterministically (0.9.15's prompt rule was not enough).** The 0.9.15 live acceptance re-ran the exact dependency request and the real model *still* minted T003 from "必须按上述顺序执行：项目B的产物依赖项目A的产物。" — a prompt rule alone cannot guarantee this. `requestTasks` (the one splitter every downstream consumer derives from: classify prompt, `bindClassifiedTasks`, `ledgerPlan`) now filters meta-only sentences outright: first segment must match a meta prefix (按上述/以上…顺序|先后|要求|依赖, or 以上任务请依次…) **and** carry no concrete payload (no path/file token, no action or business verb). The inventory is never emptied (an all-meta request keeps its single task). Red-capable criterion: `test/meta-task-filter.test.mjs`.
- **The gate is robust on a busy machine (2026-09-18, user directive: never wait for free RAM).** Two knobs and one honest fallback: `ORCH_GATE_TEST_CONCURRENCY` (default 3; lower ⇒ less memory pressure ⇒ fewer capacity-sensitive reds) and `ORCH_GATE_SUITE_TIMEOUT_MS` (default 900000). When the suite reports reds *with a complete summary*, the gate re-runs each red title's file **in isolation**: all green ⇒ recorded as an environment flake (`[gate] L1 environment flake recorded: …`, observed pass/fail logged; L4's measured total = pass+fail) and L1 passes; any file still red ⇒ real regression, the gate fails. A truncated suite (missing summary, e.g. timeout) can never be flaked green.

## 0.9.15 — core 1.16.2

### Fixed

- **Finished windows are now closed at finalize (measured on the pi battery 2026-09-18).** A successful `--mode window` pi run left its panels on screen: the unit processes and the launcher had exited, but the Windows Terminal window stayed — the only sweep (`sweepLeftoverRunWindows`) ran *before* a run, and its corpse criterion ("the Windows Terminal host has no children at all") never fires while the user keeps any other WT window open (the shared host always has children). The sweep now runs both before the runner **and after it returns**, with a per-unit criterion: a recorded window is closed only when no live process references that unit's unique stem (`win-launch-<stem>.ps1` launcher path or the unit's pi session path) — i.e. the unit is really gone — plus the existing "visible window owned by Windows Terminal" checks. Red-capable criteria: `test/leftover-windows.test.mjs` (stem pairing; the post-run sweep wiring).
- **Pure meta/process sentences no longer become tasks.** Measured in the dependency drill: the sentence "必须按上述顺序执行：项目B的产物依赖项目A的产物" became its own task (and its own block), wasting a unit. The classify prompt now states that meta sentences (constraints without a concrete action or artifact) must be merged into the task they constrain or dropped, never given their own task id.

### Added

- **`[env]` telemetry on the inline paths.** The capacity gate and the policy fallback now emit `env:{platform,node,freeMB,totalMB,capacity}` inside their JSON, so "no windows: capacity below two-windows" carries the machine state that produced it (measured: free RAM swung 0.3–3.2 GB on this box, flipping capacity 1↔4 between probes). Red-capable criterion: `test/inline-env.test.mjs`.
- **Foreground activation retries.** With several windows spawning back-to-back one window was measured ending `foreground=false` while its siblings reached the front (the pi battery's 4-window leg). The activation helper now retries the foreground switch up to 3 times (350 ms settle + 900 ms gap between tries) before falling back to the taskbar flash.

## 0.9.14 — core 1.16.1

### Added

- **Progress deadline for unproductive units (first-checkpoint deadline).** Measured 2026-09-18 in a live Codex `--mode window` run: an interrupted attempt (the user pressed ESC in the TUI) was retried correctly within seconds — the verdict came from the on-disk checkpoints, not from trying to detect the interrupt, which leaves no trace in the session rollout — but the retry then spent its whole turn analysing the prompt and the orchestrator's own sources instead of doing the task, so the task never reached its first (`started`) checkpoint. The watchdog now enforces the contract's own first step: if the attempt's `checkpoints/` directory has not moved past the spawn moment within `ORCH_UNIT_FIRST_CHECKPOINT_MS` (default 300000 ms; `0` disables), the attempt is closed early with an `unproductive: no task checkpoint within Ns …` reason and retried inside the attempt budget. The stall channel is untouched (a silently frozen unit still ends on `ORCH_UNIT_STALL_MS`). Red-capable criterion: `test/unit-stall.test.mjs` ("… trips the first-checkpoint deadline" — a live unit with a ticking session file that never checkpoints).
- **Unproductive units are auto-retried once beyond the plain attempt budget.** When every remaining task still has *no* checkpoint at the budget gate — the unit "talked but did not act" — the runner grants one extra attempt (`ORCH_UNPRODUCTIVE_RETRIES`, default 1; `0` disables) and records `unproductiveRetries` in the ledger; once that allowance is spent the budget exhaustion is reported honestly, exactly as before. Red-capable criterion: `test/transient-retry.test.mjs` ("… never writes ANY checkpoint …" with `maxAttempts: 1`).
- **`[env]` observability lines.** Every run now logs `[env] phase=start|final platform=… node=… free=…MB total=…MB capacity=…`, so environment monitoring (memory headroom and the admission capacity derived from it) is visible in the run's own stdout next to the `[board]` lines.

### Changed

- **Prompt hygiene in the unit body.** The `已独立验收的任务禁止重做：` line is emitted only when there are verified tasks — with an empty list it left a dangling colon that a live model treated as a clue about the harness — and a new hard rule instructs the unit to execute the given commands as-is instead of analysing the prompt's provenance or the orchestrator's implementation (`runner.mjs`).

## 0.9.13 — core 1.16.0

### Added

- **Transient unit failures are absorbed, not reported (auto-detect + auto-retry).** Measured 2026-09-18: in a window-mode resume two units exited with code 1 seconds after launch (a transient shared hiccup — the identical command succeeded moments later), and because a unit that wrote a `started` checkpoint but no terminal one was classified `uncertain`, one block surfaced `needs-reconciliation` to the caller while its sibling recovered on the next attempt. The runner now treats "quick death with a started-only checkpoint" as a transient signature and auto-retries the block once — `ORCH_TRANSIENT_RETRIES` (default 1), `ORCH_TRANSIENT_WINDOW_MS` (default 180000 ms), `ORCH_TRANSIENT_BACKOFF_MS` (default 2500 ms). `"retrySafe": false` vetoes the automatic retry (the escape hatch for non-idempotent work); `"retrySafe": true` keeps its "always safe to re-run" meaning. A failure that ran past the window is never masked. Red-capable criterion: `test/transient-retry.test.mjs` (before the change the run ends `success=false` with `Uncertain tasks`).
- **Power-cut posture: a deterministic bootId, durable state and a boot-time recovery scan.** A real power cut kills everything at once, so the response is boot-time convergence: (1) `atomicJson` now writes `tmp -> fsync -> rename`, and readers treat a missing/unreadable ledger as *unknown*, never "finished"; (2) every run and lease record carries `bootId` (boot time from `os.uptime()`, seconds) and a lease/run-owner from a previous boot is reclaimed even when its PID matches a live process (PIDs are reused across reboots); (3) `scripts/core/reboot-recovery.mjs` + `scripts/recover-stale.mjs` list interrupted runs and (opt-in `--resume`) converge them through the one `--resume-run` path, which is itself interruptible and converging. Red-capable criterion: `test/reboot-recovery.test.mjs`.

### Fixed

- **The Codex network policy no longer clobbers a user-declared provider.** The OpenAI HTTPS policy (`model_provider=orchestrator-openai-https`, ChatGPT auth + no WebSocket probe) used to be injected unconditionally into every Codex launch and into the SDK classify path, overriding a provider configured in the user's `config.toml`. Measured 2026-09-18 while moving Codex onto a DeepSeek provider: the injected provider produced `API key login is required, but ChatGPT is currently being used`. `codexNetworkArgs()` / `codexNetworkConfig()` now gate on the effective provider — `auto` (default) injects only while it is the default OpenAI one, `ORCH_CODEX_NETWORK_POLICY=on|off` forces either way. Red-capable criteria: `test/network-policy.test.mjs` (custom provider ⇒ no injection) and `test/host-cli.test.mjs` (argv identity pinned to the OpenAI path).
- **Resume no longer fails because the machine got busier.** `runWindows` threw `Current memory capacity is below the saved block count` when free memory at resume time dropped below the block count captured at run creation (measured 2026-09-18: created with capacity 4, resume computed 2 → the whole resume was refused, `pi` window power-cut leg). Admission is now clamped to the current capacity and remaining blocks queue in waves; the ledger's block-count upper bound is still validated against total memory, so tampering is still caught.

## 0.9.12 — core 1.15.2

### Fixed

- **A live-but-silent unit no longer waits out the run deadline (and no manual Ctrl-D).** Measured 2026-09-17: with the codex account out of quota the TUI sat on its usage-limit banner for 22+ minutes while the engine kept waiting (default run deadline is 6 h), and the only way out was a manual interrupt. The runner now watches *progress* (checkpoint file, result file, launcher `out`/`pty` logs, host session file — mtimes only, no host-format parsing): no movement for `ORCH_UNIT_STALL_MS` (default 600000 ms) means `stalled: no unit progress for Ns`, the unit is closed through the normal teardown path (descendants killed so the launcher still reaches its own `exit 0`; the launcher itself is never force-killed, which would leave a `[process exited, code 1]` pane), and the block retries inside its attempt budget. `ORCH_UNIT_TIMEOUT_MS` (default 2700000 ms) caps one unit's lifetime; the exhausted-budget reason now carries the last attempt's failure text. Red-capable criterion: `test/unit-stall.test.mjs` (a fake launcher that sleeps for 600 s plus a never-resolving wait hook must end as `stalled`, be closed out and retried — before the change the run hangs).
- **Leftover corpse windows are swept.** After a killed unit or a power cut, Windows Terminal keeps dead-pane windows ("[process exited …]") open. The engine now closes the windows it recorded for this run (`win-*.window.json` handles) when they are still owned by Windows Terminal and that host has no live children — never touching other windows. `leftoverWindowHandles()` is the pure, red-capable criterion (`test/leftover-windows.test.mjs`).


## 0.9.11 — core 1.15.1

### Fixed

- **pi host died on an ambiguous model name.** pi's `settings.json` keeps `defaultProvider` and `defaultModel` apart; the detector only read `defaultModel`, so a bare `--model deepseek-flash` reached a pi install with several authenticated providers for that alias and pi refused with `Model "deepseek-flash" is ambiguous across providers: … Use --provider or provider/model` (exit 1). In `--mode window` the TUI therefore exited immediately and every block was marked failed while the windows themselves popped correctly (measured 2026-09-17, pi 0.85.1). `detectPi` now composes `provider/model` when `defaultProvider` is set and the value is not already qualified, and passes an already-qualified spec through untouched. Red-capable criterion: `test/host-model.test.mjs` (`defaultProvider=opencode-go` + `defaultModel=glm-5.3-flash` must yield `opencode-go/glm-5.3-flash`; before the fix it yields the bare name).


Notable changes, newest first. Every entry pairs a package version with a core version —
`open-tui-orchestrator --version` prints both (`open-tui-orchestrator <version> (core <core>)`).

## 0.9.10 — core 1.15.0

### Added

- **An L1 red now names the failing tests.** Measured 2026-09-17: a gate round went red with one failing case (plus the L4 cross-check cascade) and the name turned out to be *unrecoverable* — L1 printed counts only, and the re-judgement of the same head overwrote both `gate-<head>.log` and `judged-<head>.json`. `scripts/gate.mjs` now extracts the failing tests from the reporter's `✖ failing tests:` section (`suiteReds`, with an inline-marker fallback for interrupted runs; it never fabricates), prints them inside the L1 block, prints one machine line `[gate] suite reds (N): name @ file:line:col | …`, and dumps the full suite output to `temp/gate-suite-<stamp>.log`. `tools/orch-patrol.py` parses that line into the judgement record as `suite_reds` and echoes `PATROL_GATE_RED:` lines when a judgement fails. New red-capable criterion: `test/gate.test.mjs` (the parser must name the red test from a reporter fixture, must stay empty on marker-less and green output; before the change `suiteReds` does not exist ⇒ red). Regression 296/296.

### Fixed

- **`--mode window` now actually shows windows.** Measured 2026-09-17 with a top-level-window probe: the spawned Windows Terminal window was `visible=True showCmd=1(normal)` but was *never activated*, and the launcher helper spent 2.5 s pushing the previous foreground window back to the front — so windows opened *behind* whatever the user was looking at, and two full test rounds produced zero visible popups. The popup criterion (pidf + launcher process alive) reported `popup CONFIRMED` throughout, i.e. it was a false green. Now `inactive-window.ps1` takes `-Activate` (default in window mode): it snapshots top-level windows, waits up to 9 s for the fresh sane one, restores it with `ShowWindow(SW_SHOWNORMAL)`, raises it (topmost → not-topmost) and asks for the foreground, then prints a machine-readable verdict (`ok/hwnd/rect/foreground/raised/minimized`). The engine stores that verdict next to the pidf (`win-<stem>.window.json`), logs it on the spawn line, and `windowGenuinelyPopped` now **requires** `ok:true`, so a window sitting behind other windows can no longer pass as a popup. `ORCH_WINDOW_NOACTIVATE=1` restores the old background behavior. Red-capable criteria: `test/inactive-window.test.mjs` (`-Activate` flag + verdict plumbing, `ok:false`/exit-3 and no-verdict failures, helper stays ASCII+LF+PowerShell-parseable) and the rewritten `windowGenuinelyPopped` case (live launcher with no verdict ⇒ false).

### Changed

- **Window capacity now comes from *available* memory**: `maximum windows = floor(available memory MB ÷ 1000) × 2` (never below 1), replacing `round(nominal GB × 3 ÷ 4)` computed from *total* memory — the old form counted memory other processes already held as spare capacity. Read per decision via `os.freemem()`; README, README-zh and `docs/pi-adapter.md` state the new rule and the regression numbers were updated for it.

## 0.9.9 — core 1.14.9

### Fixed

- **Resume adoption of a surviving unit no longer mis-reads one transient identity-snapshot miss as a dead launcher.** Measured 2026-09-16 with the L5 recovery drill re-run on the headless carrier: after the controller was killed, the guardian's resume engine read the live unit's identity with a *single* process snapshot; when that read missed (a known under-load form), the started-but-unproven task was cascaded into `needs-reconciliation` and the run finalized `success=false` about a second after resume — the drill's second kill hit a dead PID and the "stays unfinalized → guardian visibly exhausts → manual re-supply finalizes" scenario could not reproduce (it had passed on the window carrier, a timing accident of the same cause). On a resumed generation (>1) whose unit has no result file yet, the adoption read now uses the same bounded grace-retry as the spawn read (`identityWithGrace`, the default 10 s / 800 ms poll; if the identity still cannot be read the block falls back to recovery, and the engine stays alive through the grace so a re-kill still has a target): a live unit is adopted (`[resume] adopting live <block>; no duplicate window`) and the run keeps waiting on it. Fresh runs and the result-file-present path keep their single-read legacy semantics (the result is read from `rf` anyway, so identity is not required there), so existing fresh-run criteria are untouched. Acceptance: the drill's fail leg re-run goes rc=0 (`passed=true`, `stayedUnfinalized`/`manualResumeFinalized` both true, salvage rc=0) and the auto leg rc=0 — zero popups on both (WindowsTerminal count 0→0); `gate.mjs --all` PASS, regression 295/295.

## 0.9.8 — core 1.14.8

### Fixed

- **The regression and the gate no longer change with the shell's `ORCH_SPAWN_MODE`.** Measured
  2026-09-16: on a machine whose user-level `ORCH_SPAWN_MODE=window` (kept on purpose so manual runs
  show windows), `gate.mjs --all` went rc=1 and the suite went 289/294 — *and really popped visible
  windows*. Four headless-default assertions (`caller-driven` / `orch-force` / `print-profile` /
  `spawn-mode`) inherited the variable from the shell, `queue-backoff` silently ran on the window
  carrier, and `release-package` flipped green/red with the shell's `ORCH_AGENT` (a published copy's
  `--doctor` only diagnoses the missing SDK when a codex host is requested — `gate.mjs` forces
  `ORCH_AGENT=codex`, a bare suite run inherits the shell). The user-level variable stays; the fix is
  on the consumer side: `scripts/gate.mjs` pins every child to `headless` and reports the initiating
  shell's value (`[gate] shell ORCH_SPAWN_MODE=…; children pinned to headless`), the unit-spawning
  tests (`caller-driven`, `orch-force`, `print-profile`, `queue-backoff`), the `adapt --smoke` block
  acceptance and `tools/orch-level-check.py` pin `headless` explicitly, the spawn-mode default
  assertions strip the variable, the `--mode window` case passes the flag, and `release-package`
  pins `ORCH_AGENT=codex`. Acceptance 2026-09-16: `gate.mjs --all` green with the variable set in the
  shell and again without it, zero popups, logs filed
  (`D:/temp/orch-L5-gate-fix-window-20260916.log`, `D:/temp/orch-L5-gate-fix-novar-20260916.log`).
  New red-capable criterion: `test/gate.test.mjs` (the gate must report the shell value and stay
  green; before the change the line does not exist ⇒ red). Regression 295/295.

## 0.9.7 — core 1.14.7

### Fixed

- **Process-identity failures are now diagnosable.** Measured 2026-09-15: a single
  `Get-CimInstance Win32_Process` call took **79.8 s** on this machine (WMI/CIM degraded under
  load) while the engine's snapshot budget is 15 s — every action entry then failed closed with a
  bare `Cannot verify process identities`, which names neither the elapsed time nor the cause and
  offers no way out. The line now carries the budget, the elapsed time, the cause and the knob:

  ```
  before:  [orchestrator] FATAL: Cannot verify process identities
  after:   [orchestrator] FATAL: Cannot verify process identities: the process snapshot did not
           return within 15000 ms (elapsed 15210 ms; the machine may be under heavy load);
           retry, or raise ORCH_PS_TIMEOUT_MS (budget 15000 ms, cap 120000)
  ```

  `ORCH_PS_TIMEOUT_MS` raises the budget (default 15000 ms, capped at 120000 ms). New red-capable
  tests: `test/snapshot-diagnostics.test.mjs` (a 1 ms budget must fail with the elapsed time and
  the knob named; the env override and the cap are asserted).

## 0.9.6 — core 1.14.6

### Fixed

- **A dead model account no longer hides behind a parser-sounding message.** When the classify
  call returned nothing because the account was out of quota (or not logged in, or the network
  failed), the failure line read `no JSON in classify output: (no valid JSON) -> fallback to
  single serial block` — which looks like a parsing bug. `runThreadPrompt`'s `errored`/`warnings`
  (where the real reason lives) were being dropped. The line now carries the underlying reason,
  bounded to one line:

  ```
  before:  decompose LLM failed after 2 attempt(s): no JSON in classify output:  (no valid JSON) -> fallback …
  after:   decompose LLM failed after 2 attempt(s): classify model call failed: You've hit your usage limit. Visit
           https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 19th, 2026 4:10 PM. -> fallback …
  ```

  Verified by before/after on this machine with the same command and the same account state (the
  released 0.9.5 copy versus the fixed tree); the reason text comes from the account, so the run
  also tells you when it recovers. Recorded in `test/acceptance-2026-09-15-windows-guard-live-run.json`.

- Recorded, not fixed (honest boundary): when units themselves fail on quota exhaustion, the run
  correctly reports `success: false` with `failed` tasks and no fake success, but the per-task
  reason is the generic `No durable task checkpoint` / `Safe recovery attempt budget exhausted`;
  the underlying CLI text stays in `runs/<id>/attempts/`. Surfacing the unit-level reason is a
  follow-up, not claimed here.

## 0.9.5 — core 1.14.5

### Fixed

- **The Windows-only promise is now enforced, not just documented.** Measured: with no guard, a
  simulated non-Windows platform reported a *healthy* `--doctor` (exit 0, `"terminal": "wt"`) and
  `--run-windows` proceeded to a real classify call — the front page claimed "other platforms get
  a diagnostic instead of a half-working install", and that claim was false. The refusal now
  happens in `scripts/platform-guard.mjs`, called by `cli.mjs`, `orch.mjs` and the SDK wrapper
  before host resolution, before any model call and before any state: one
  `[orchestrator] FATAL: Windows-only: …` line, exit 1, no stack. `--version`, `--help` and
  `--install-deps` stay available because they are platform-neutral and are what you need when
  debugging a platform issue (they are what the criterion pins as still working).

### Added

- `test/windows-only.test.mjs` — two criteria, red-capable in both directions (remove the guard →
  case 1 fails; widen it to every entry → case 2 fails). The red case was demonstrated for real:
  guard removed from a copy, copy resealed, fake platform → healthy `--doctor`.

### Verified

- A live two-block run against the **released** copy (0.9.4) through the caller-driven channel
  (`--plan-file` + `--unit-cmd-file` + `--acceptance-file`, zero model calls): board reached
  `2/2 verified … finalized success=true`, products `alpha.txt=ALPHA_OK` / `beta.txt=BETA_OK`
  written and hash-recorded, both tasks `verified` with `completed` checkpoints, ~60 s.
- Environment note recorded in the evidence file: the codex account on this machine is out of
  quota until 2026-09-19, so a model-driven run could not be executed today; the orchestrator
  degraded correctly (inline fallback, no fake success) instead of pretending to run.

## 0.9.4 — core 1.14.4

### Added

- **`scripts/gate.mjs` — the machine gate now lives in the repository** and anyone can run it:
  `node scripts/gate.mjs --all` runs L1 the offline regression suite, L2a host resolution,
  L2b a deliberately failing test (proof that the criteria can still go red), L3 the unknown-run
  diagnostic and L4 the version / seal / documentation / suite-total cross-check plus a stale
  mutex-ticket sweep. Every criterion prints command, expectation and actual; a value that cannot
  be read counts as a failure.
- **`.github/workflows/ci.yml`** — the same gate on a clean `windows-latest` runner, including the
  codex install and the `--install-deps` bootstrap self-test. It ships **disarmed** (manual
  trigger only) so that pushing to a private repository never spends Windows runner minutes;
  the header comment names the two lines that arm it.
- **`docs/trust-and-safety.md`** — a plain statement of what this tool does on your machine:
  hidden agents running with your credentials, the Codex approval bypass, what `--unit-cmd` means,
  every file it writes, and the fact that there is no telemetry, daemon or auto-update.
- **`SECURITY.md`** — private vulnerability reporting, scope, disclosure timeline.
- **`CONTRIBUTING.md`** — the house rules (criteria must be able to go red, seal discipline,
  single-source numbers).

### Changed

- README / README-zh lead with the **Windows-only** statement and link the trust statement,
  security policy and contributing guide.
- `INSTALL.md` documents `node scripts/gate.mjs --all`, `node scripts/release-integrity.mjs`
  and `ORCH_NPM_BIN`.

## 0.9.3 — core 1.14.3

### Fixed

- **`--install-deps` is now reachable exactly when you need it.** If your environment sets
  `ORCH_AGENT=codex`, the wrapper used to run the SDK dependency check (and the engine to
  `import` `@openai/codex-sdk` at load) *before* the bootstrap entry could run — a deadlock for
  anyone with missing dependencies. The bootstrap now runs before the engine, and its
  implementation lives in `scripts/install-deps.mjs`, which imports nothing but Node builtins.
- **A successful install is no longer reported as a failure.** The dependency probe was computed
  once before the install, so `npm ci` succeeding (exit 0) still produced
  `FATAL: dependency install failed`. It is re-checked after the install, and the success path now
  has a regression test (offline, with an npm stub).
- `ORCH_NPM_BIN` (new) points at a custom or corporate npm; a missing toolchain is reported with
  the manual fallback command instead of a Node stack.

### Changed

- **Publishing metadata**: `private` removed, `description` / `keywords` / `author` / `license` /
  `repository` / `homepage` / `bugs` added, and an explicit `files` list now excludes `test/` and
  `scripts/node_modules` (without that exclusion the tarball picked up 385 MB of dev
  dependencies — 143 MB packed; with it, 89 files / 292 kB). `npm publish --dry-run` is green.
- **Machine identity stripped from the repository**: 18 tracked files / 77 occurrences of the
  authoring machine's user name are normalized to `<user>`, and the root causes are fixed so
  future artifacts stay clean (evidence collector, profile adapter provenance, the shipped hermes
  profile).
- npm is invoked through `node_modules/npm/bin/npm-cli.js` when available (no `shell: true`,
  no `DEP0190` warning, no shell-quoting of paths).

## 0.9.2 — core 1.14.2

### Added

- **`--install-deps`** — a first-class entry that installs this package's own locked SDK
  dependencies (`@lydell/node-pty` for the invisible ConPTY carrier, `@openai/codex-sdk` for
  Codex-hosted runs). Idempotent (a second run prints `already-present` without touching the
  network), stdout stays pure data, and a failure names the manual fallback command. A public
  install is now three commands.
- **`INSTALL.md` / `INSTALL-zh.md`** and a README install section, plus
  `docs/public-readiness.md` — an explicit list of what is done and what is still missing before
  this can be released publicly.

## 0.9.1 — core 1.14.1

### Fixed

- Coordinator mutex tickets are reclaimed on **every coordinator-directory resolution** (an idle
  machine no longer keeps residue until the next transaction), and the helper polls its release
  file every 100 ms instead of ~1 s — tickets vanish within ~300 ms. 576 leaked tickets were
  observed on a long-lived machine and removed.

## 0.9.0 — core 1.14.0

### Fixed

- **Coordinator mutex hardening.** The wait was hard-coded at 20 s inside the helper and 30 s on
  the JS side, so nine contending parents under load produced false
  `Coordinator mutex acquisition failed` results (2/9 in a full-suite run). Now: tunable wait
  (`ORCH_MUTEX_WAIT_MS`, default 60 s), retries with exponential + jittered backoff
  (`ORCH_MUTEX_RETRIES`, default 2), a JS-side bound derived from the same value, and age-based
  ticket reclamation (`ORCH_MUTEX_TICKET_TTL_MS`, default 10 min).
- `queue-backoff`'s end-to-end failure output now carries the per-block reason.

## 0.8.0 — core 1.13.0

### Added

- **Machine-caller failure contract.** Every public entry fails closed with exactly one
  `[orchestrator] FATAL: <reason>` line (Node stacks only with `ORCH_DEBUG=1`); exit codes are
  0 success / 1 refused / 2 usage.

### Fixed

- `--verify-run` / `--resume-run` on an unknown run id now answer `Run not found: <id>` instead of
  a raw `ENOENT` plus a four-frame stack.
- `--watch <unknown run>` used to poll **forever** with no output; it now honours a bounded grace
  (`ORCH_WATCH_GRACE_MS`, default 60 s — the run directory may legitimately not exist yet while
  `--run-windows` is still planning) and reports a summary that disappears mid-watch.

## 0.7.0 — core 1.12.0

### Added

- Queue wait backoff: capacity/conflict waiters back off exponentially with jitter
  (`ORCH_WAIT_BACKOFF_MS`, `ORCH_WAIT_BACKOFF_MAX_MS`); waiting state rewrites the board only when
  the reason changes.
- OpenClaw version-gate diagnostics: the runtime `tui` interface probe runs first; unverified
  versions fail closed carrying the probe result, node-pty presence and the last-verified version.
- `orch-adapt` shim for the adaptation entry.

## 0.6.0 — core 1.11.0

### Added

- Initiating-agent alignment: an adapter-less initiator with a landed profile (Hermes) is a
  first-class auto host — its own CLI becomes the executor, with `--no-restore-cwd` guarding
  against stale-session CWD writes.
- Model/effort inheritance for caller-driven runs, and model/effort traceability in
  `summary.json` (value plus source: explicit / host session / host-default).

## 0.5.0 — core 1.10.0

### Added

- Unit carrier tiering: TUI-class agents run on an invisible ConPTY pseudo-terminal carrier by
  default (a real console, no window, no focus steal); print-class CLIs keep the no-console
  carrier. Identity, lease and recovery contracts are unchanged.

## 0.4.0 — core 1.9.0

### Added

- Caller-driven channel: `--plan-file` (caller-supplied ledger/blocks, zero model calls in the
  run), `--unit-cmd` / `--unit-cmd-file` (bring any CLI without an adapter), read-only `--tasks`
  to align ids first, and resume identity rules for unit commands.
