# 实机验收记录：Codex 固定容量 / 异常中断收窗 / 首件真实任务

本轮做三项实机验收，全部在 Windows / node v26.7.0 上跑，产物与日志见各节"证据"。

## 一、Codex 固定容量验收（9 任务 / 8 窗口契约）

同一契约跑两轮，唯一差别是首检查点预算：

| | 第 1 轮 | 第 2 轮 |
|---|---|---|
| `ORCH_UNIT_FIRST_CHECKPOINT_MS` | 默认 300000 | 1200000 |
| 无产出自动重试 | 3 块被重试 | 0 |
| 观测到的并行窗峰值 | 8 | 7 |
| 最好的 (live, ready) | (8, 4) | (7, 5) |
| `live===8` 与"前 8 块全部已写 started"同时成立的采样数 | **0 / 310** | **0 / 263** |
| 结果 | `success=false`，1/9 verified | `success=false`，1/9 verified |
| 收尾 | 0 残留 | 0 残留 |

**闸门条件**（`test/live-codex.mjs`）：`live.length === capacity && 前 capacity 个 id 都已写 started.json` 同时成立才写 `release`；九块中最后一块按设计豁免等待，因此每轮只有它通过。

**根因（由采样证明，非推测）**：codex 单元首次写检查点的耗时为 4–18 分钟（`started.json` 实测落盘时刻），而先完成的单元此时已退出、`live` 回落——两个条件被启动节奏永久错开。第 2 轮放宽预算消除了重试，但没有改变错开本身。

**归因**：agent 能力不计（单元正确执行了任务、写了检查点、跑了探针；豁免的那一块端到端通过）；编排器适配不计（弹窗确认全 OK、cwd 继承正确、收尾干净、峰值 8 达成）；原因是宿主启动节奏（codex 侧）叠加闸门要求"同一瞬间"的脆弱性。**同一闸门在 hermes 宿主上是满足过的**，所以闸门并非不可满足。

**结论**：固定容量契约在启动慢的宿主上不可达；这是测量方式的性质，不是产品能力。未改动任何判据。

## 二、异常中断收窗演练（caller-driven 通道，零模型调用）

方法：2 个可见窗口 + 2 个长跑单元；用 `guardian.json` 取权威 pid（`guardianPid` 与 `engines[].owner.ProcessId`），`Stop-Process` **只杀引擎、不带 /T**。

| 观察 | 结果 |
|---|---|
| 杀后 20 秒：单元 / 窗口 / 守护 | 2/2 存活、窗口在、守护存活 |
| 守护动作 | `engine lost (pid=…); resuming run <id> (restart 1/3)`，`restarts=1`，新引擎由守护拉起 |
| 终判 | `success=true`、`generation=2`、两块均 verified |
| 收尾 | 窗口 0、单元 0、引擎 0、守护 0、启动器 0（按进程名过滤后的进程表读数） |

**接管方式（首轮误读已由重跑推翻）**：重跑（同样杀引擎）后读**恢复引擎自己的日志**得到决定性证据——`[resume] adopting live B1; no duplicate window` / `… B2 …`，`spawned visible` 行数 **0**、`adopt` 行数 **2**，与 `docs/auto-recovery.md` 的断言一致：**按身份收编存活窗口，不重复开窗**。首轮之所以看成"重新派发"，是把第一代引擎日志尾部的**最初弹窗记录**当成了接管后的新动作，且始终未读恢复引擎的日志（`resumed-engine-*.log`）；该误读已撤回。判据记法：接管方式只看恢复引擎日志里的 `adopting live` 行，不看首轮日志的 `spawned visible`。

**另一轮对照**：守护进程本身被杀时，引擎照常收完并 `success=true`、窗口全收——正常路径的收窗不依赖守护。

## 三、首件真实任务：工作区残留清理

请求按区域分类为两块（`--tasks` 台账对齐后），hermes 宿主、可见窗口、验收只看盘上断言（`verify-cleanup.mjs`，已先自测"清理前必红"）。

| 区域 | 内容 | 执行者 | 验收 |
|---|---|---|---|
| OTUI 仓 `temp\` | 1279 项测试夹具 | 发起会话（见下） | PASS |
| `<workspace>\temp` | 运行残留（unit-peak-* / win-B*.window.json / live-codex-*.log / open-live-*） | hermes 单元（3 次尝试） | PASS |
| 旧 C 盘工作区 | OTUI 残留 | hermes 单元（1 次尝试） | PASS |

终判 `success=true`、2/2 verified；跨区域保护断言（其他开发线目录、审计证据、`.git`）全部 PASS；窗口收尾 0。

**三条实测发现**：

1. **自改保护生效**：请求一旦包含编排器自身目录，引擎回 `{"mode":"inline","reason":"Modify the orchestrator in the initiating conversation before opening windows"}` 并拒绝开窗；该区由发起会话自行清理。这是设计内行为。
2. **首检查点默认预算对本机 AI-CLI 单元偏紧**：一块连续两次在 `no task checkpoint within 300s` 上被提前收口，第三次成功——重试能把活救回，但预算本身是同一个旋钮（`ORCH_UNIT_FIRST_CHECKPOINT_MS`，默认 300000）。**同日处置**：该默认已按本实测上调为 `1200000`（20 分钟，两处判定点同值；真僵死仍走 `ORCH_UNIT_STALL_MS` 通道），见 `docs/release-policy.md` 同日条目与 `docs/execution-contract.md`。
3. **任务目标与引擎自用暂存区可重叠**：单元把引擎本轮正在写的 `unit-peak-*` 采样文件一并清掉，引擎未受影响，终局仍 `success=true`。设计清理类任务时应把这部分排除。

## 证据

- 日志：`<workspace>\temp\live-codex-20261009.log` / `…-r2.log`；`…\otui-abort-drill-20261009\drill-run.log` / `drill-run2.log`；`…\otui-cleanup-20261009\run2.log`
- 采样与报告：`…\open-live-*` 的 `report.json`（含 310 / 263 个 (live, ready) 采样）；`…\temp\orchestrator\runs\<runId>\summary.json`
- 验收脚本：`<workspace>\temp\otui-cleanup-20261009\verify-cleanup.mjs`
