# Kimi Code 集成：发起窗 todolist 镜像与 spawn 群状态

编排器侧只提供**状态流**，Kimi Code 侧的原生机制（TodoList、后台任务）由**发起 agent** 负责镜像。
原因：Kimi Code 0.42.0 没有可供外部进程挂载的 hooks 通道，编排器是子进程，无法直接写发起会话的 TodoList；
"用发起 agent 本身就有的机制" 只能在 agent 侧落地——agent 读流、更新自己的列表。本文给出固化套路。

## 数据源（编排器已内建）

| 通道 | 形态 | 用途 |
|---|---|---|
| 引擎 stdout `[board] …` | 每次状态迁移追加一行（`run=… gen=… mode=… N/M verified [B1✓ B2▶] finalized success=true`） | 后台任务输出里天然可见；人类可读 |
| `--watch <runId> --jsonl` | 每次变更输出一条 JSON（blocks[].status/attempts、tasks[].status/checkpoint、finished/success） | **agent 镜像的首选输入** |
| `--watch <runId>`（TTY） | 原地重绘的完整看板（块行 + 状态 + 任务标记） | 人类终端的常驻模块 |
| `--status --readonly` | 活动 run 的看板行 | 快速一瞥 |
| `runs/<id>/summary.json`、`events.jsonl` | 权威账本与事件流 | 终审与审计 |

## 镜像套路（发起 agent 侧，实测有效）

1. **一次 run = 一个后台任务**：用 Kimi Code 的原生后台任务跑编排入口，天然获得任务面板与完成通知；
   同时再挂一个观察任务：
   ```bash
   node <cli> --agent kimi --run-windows "<请求>"          # 后台任务 A：编排
   node <cli> --agent kimi --watch <runId> --jsonl          # 后台任务 B：状态流
   ```
2. **agent 周期性读 B 的末条 JSON，更新自己的 TodoList**（无需要求 agent 盯着；每次自己回合末端同步一次即可）。
3. **字段 → TodoList 映射**：

| 看板字段 | TodoList 渲染 |
|---|---|
| `blocks[].key/title` | 每个块一个待办项（标题=块名） |
| `blocks[].status` = `pending/launching/running` | 该项「进行中」 |
| `verified` | 该项「完成」 |
| `failed/timeout/needs-reconciliation` | 该项「失败」，追加 `blocks[].reason` |
| `tasks[].checkpoint`（`started/completed`） | 项内子进度徽标（比 `tasks[].status` 更早、更真：块在跑时任务级状态仍 pending） |
| `blocks[].attempts` > 1 | 标注「第 N 次尝试」 |
| `finished/success` | 全部项收官；`success=false` 时按块报告失败原因 |

4. **spawn 群状态**：`blocks[]` 即单元群（headless 与 window 同构；`attempts` 即重试代数）。
   想单独一项显示，可新增一个「Spawn 群」待办项，内容直接画 `spawned headless/visible …` 行或
   `B1▶ B2⏳` 摘要；块级状态同时镜像到各自待办项即可，不必双份维护。

## 实测记录（2026-09-11，kimi 0.42.0，core 1.8.0）

- run `kimi-nativesync`：2 块 × 3 任务（真实开发任务：format.js+自测 / check.js+自测），headless 全程；
- 镜像片段（真实取值）：
  - 第 1 次同步：`B1 running（T001✓ T002✓ T003▶）/ B2 running（无检查点）`；
  - 第 2 次同步：`B1 verified（三任务 completed）/ B2 running`；
  - 终态：`finished=true success=true`，T001-T006 全部 `verified + checkpoint completed`。
- 结论：task 级进度必须读 `checkpoint` 字段（块在跑时 `tasks[].status` 会滞后到 pending）；
  流式 JSONL 是 agent 镜像的可靠输入。

## 边界

- TodoList/后台任务是 **Kimi Code agent 运行时**的原生机制（本套路不依赖任何编排器改动）；
- 编排器不写、也写不了发起会话的会话状态；run 的终审以 `summary.json` + 验收契约为准；
- 其它 agent（claude/codex 等）同理：各自用其原生 todo/后台机制镜像同一份流。
