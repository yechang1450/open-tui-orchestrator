# open-tui-orchestrator

面向带 CLI（命令行接口）的 Agent（能够接收任务并调用工具完成工作的智能体）的本地 Node.js 编排器。

**当前仅支持 Windows。** 启动器、不可见 ConPTY 载具与机器级协调器都是 Windows 专有实现；其它平台会直接给出诊断而不是「半能用」的安装。运行前请读 [docs/trust-and-safety.md](docs/trust-and-safety.md)——它直说这个工具在你的机器上做什么（隐藏窗口里以你的凭据运行的 agent、Codex 宿主运行的审批旁路、它到底写哪些文件）。安全报告：[SECURITY.md](SECURITY.md)；参与开发：[CONTRIBUTING.md](CONTRIBUTING.md)。

## 大体介绍

open-tui-orchestrator 面向复杂、较长、包含多个可独立推进部分的执行请求。它先建立完整的 TODO LIST（待办清单）、原始任务账本和依赖关系，再把语义判断与确定性调度分开：模型只负责补充任务归属、资源和依赖信息，代码负责检查任务是否完整、处理冲突、划分执行块和安排依赖波次。

规划结果确实存在可并行的任务时，编排器会在发起对话所在的工作区打开多个可见 TUI（终端用户界面）窗口，并让它们同时执行。每个窗口只负责自己的任务块；窗口之间通过资源冲突键、依赖关系和容量租约（限制同一时刻窗口数量的共享记录）协调。任务开始、完成、结果验收和关窗都要留下持久化证据，整批任务全部验收后才算完成。

编排器服务于复杂长任务，不会把每个小指令都套上一层窗口。单任务、单块计划或只能按依赖串行推进的请求不触发开窗；CLI 返回完整的原始任务清单和规划原因，由发起 Agent 在当前对话中直接执行。只有同一依赖波次至少有两个可执行块时，才进入并行执行——默认无窗 headless（同一 launcher 换隐藏载具，不弹窗、不抢焦点），`--mode window` 可切换为可见 TUI 窗口；因此不开窗不会意味着任务被丢弃。

窗口容量按**当前实际剩余可用内存**计算：每满 1000 MB 可用内存给 2 个窗口。

~~~text
最大窗口数 = floor(剩余可用内存 MB ÷ 1000) × 2
~~~

`floor` 表示向下取整，结果不低于 1。例如剩余可用 8000 MB 得到 16 个窗口，4000 MB 得到 8 个，900 MB 得到 1 个。用**剩余可用**而不是总内存是有意的：别人已经占住的内存不是这次运行能支配的容量。实际同时活动的窗口数还要经过跨运行、跨工作区的全局协调器确认；活动窗口和正在启动的预留窗口都会占用容量。任务数超过容量时，多出的任务会并入已有块，在块内按依赖串行执行，不会被推迟到下一批，也不会从原始账本中删除。

例如，剩余可用 8000 MB 得到 16 个窗口容量；9 个互不冲突的任务会形成 9 个单任务块，最多同时打开 9 个窗口，9 项任务仍全部进入账本并完成验收。

单元会自我防御：进程还活着但不再产出任何证据（检查点不动、结果文件不出现、启动器日志不增长）的单元，在 `ORCH_UNIT_STALL_MS`（默认 600000 ms）后被判定为**停滞**，随即关窗并在该块的尝试预算内自动重跑，而不是一直等到运行上限；`ORCH_UNIT_TIMEOUT_MS`（默认 2700000 ms）限制单个单元的最长寿命。被杀单元留下的残窗会在执行器启动前被收掉，掉电/被杀之后不会留下一排死窗格要人手动关。

Windows Terminal 是默认承载。窗口沿用发起对话的工作目录；`--mode window` 下新窗口会被**主动带到最前**（置顶再取消置顶，并请求前台），确保发起运行的人真的看得见它——要回到"开在后台、不抢焦点"的旧行为，设 `ORCH_WINDOW_NOACTIVATE=1`。启动脚本、结果、锁、拆解缓存和恢复账本统一放在发起工作区的 `temp/orchestrator`；宿主 Agent 自己的配置、会话和凭据仍由宿主管理。PowerShell 只承担 Windows 生命周期、编码和进程树管理辅助，窗口承载和 Agent 适配优先走 Node.js 与 Windows Terminal。

Codex、pi、opencode、Kimi Code、Claude Code 和固定版本 OpenClaw 适配器（把不同宿主 CLI 的参数、输出和关闭方式转换成统一协议）已经接通。宿主由 `--agent`/`ORCH_AGENT`、宿主环境标记或 Windows 祖先进程链自动识别——哪个 agent 发起，窗口就用哪个 agent 的 CLI，且窗口继承发起窗当前使用的 model 与 thinking effort（显式 `ORCH_MODEL`/`ORCH_EFFORT` 优先；否则按宿主检测——Codex rollout、Kimi Code 会话 wire 日志、pi settings、opencode 与 Claude 配置，画像 agent 按其 `modelDetection` 规格——最后回退到 CLI 自身配置）。未知 Agent、未验证的 CLI 或缺失的可执行文件会直接给出诊断，不会自动安装，也不会回退到另一个 Agent。已经授权的执行上下文在 TUI 窗启动后直接执行，不插入额外人工确认；编排器只继承调用方已有权限，不扩大权限范围。

## 安装

```powershell
npm install -g open-tui-orchestrator
open-tui-orchestrator --install-deps          # 拉取本包锁定的 SDK 依赖（联网一次）
open-tui-orchestrator --agent codex --doctor  # 验证：hostError null、carrierAvailable true
```

环境要求：Windows 10/11（x64）、Node.js 22+、Windows Terminal（推荐），以及一个你**已经安装并登录**的 agent CLI——Codex、pi、opencode、Kimi Code、Claude Code 或版本锁定的 OpenClaw。工具不会安装或替换任何 agent CLI。tarball 安装、源码安装、升级/回滚、卸载与排错见 **[INSTALL-zh.md](INSTALL-zh.md)**（English: [INSTALL.md](INSTALL.md)）；公开可用性的现状与缺口见 [docs/public-readiness.md](docs/public-readiness.md)。

## 什么时候适合使用

它适合一次请求同时涉及多个项目、多个目录、多个相互独立的修复，或者需要先完成前置工作再进行收尾验证的长流程。编排器会先保留完整任务清单，再做项目归属、资源冲突和依赖分析；只读分析、方案讨论以及编排器自身的修改留在发起对话。

简单小任务、单个动作、纯串行链条和只读请求直接在当前 Agent 中完成更合适。`--spawn` 是“明确要求单独打开一个可见窗口”的手动入口，不代表普通编排请求会为单任务开窗。

## 快速开始

命令从发起对话的工作区执行，不需要先切换到安装目录。下面假设 `cli.mjs` 已在当前目录或调用路径中；也可以替换成安装目录的绝对路径：

~~~powershell
node cli.mjs --agent codex --doctor
node cli.mjs --agent pi --doctor
node cli.mjs --agent claude --doctor
node cli.mjs --agent openclaw --doctor
node cli.mjs --agent codex --workspace 'D:\your-project' --plan '修复项目81登录页并优化项目82购物车'
node cli.mjs --agent codex --workspace 'D:\your-project' --run-windows '修复项目81登录页并优化项目82购物车'
node cli.mjs --tasks '修复项目81登录页；优化项目82购物车'
node cli.mjs --plan-file plan.json --unit-cmd-file unit.json --run-windows '修复项目81登录页；优化项目82购物车'
~~~

`--plan` 只规划不执行；新鲜的 `--run-windows` 只有检测到并行波次才开窗；`--resume-run <id>` 接管中断后的已保存运行；`--verify-run <id>` 只重新验收，不重跑任务；`--status --readonly` 查看窗口、租约与活动 run 看板行；`--watch <id> [--jsonl]` 只读流式查看执行看板；`orch` 命令是强制编排入口——等价于 `--run-windows` 但跳过全部 inline 回退（单块、纯串行、只读定性、自改请求都会照常派发单元），除维护锁外 100% 被调用。发起窗把看板流镜像进 Kimi Code 原生 TodoList / 后台任务的固化套路与字段映射见 `docs/kimi-integration.md`；未适配的 print-class agent CLI 用 `node scripts/adapt.mjs`（或 `ORCH_AUTO_ADAPT=1` 自动模式）完成探测→画像→活验→重封→自动提交，见 `docs/adapt.md`。任何 agent 还可以完全不带适配器地调用：`--plan-file` 接收调用方自己的账本/分块（全程零模型调用），`--unit-cmd`/`--unit-cmd-file` 自带单元命令，直接绕过宿主识别、探测与适配器名单；`--tasks "<请求>"` 打印权威 `T001…` 账本，便于先对齐 id——详见 `docs/caller-driven.md`。安装依赖可运行 `npm run setup`，离线回归运行 `npm test`。

## 起因：为什么要做这个工具

起因有两个。

第一个起因，是为了让 Kimi K3 发挥更大的能力，我专门安装了 KimiCode 来使用 Kimi K3。在一次代码量极大的 review（代码审查）任务中，Kimi K3 让 KimiCode 启动了 swarm（并行代理群），同时派出 10 个 coder subagents（编码子代理）执行不同部分。我看到后认为，这种并行执行在大任务上确实能显著缩短等待时间、提高整体吞吐。

![KimiCode 启动 10 个 coder subagents 的现场截图](docs/assets/kimicode-agent-swarm-10-subagents.png)

*图：KimiCode 在 Kimi K3 驱动下同时派出 10 个 coder subagents。这是本项目并行窗口设计的动机参考图，不是 open-tui-orchestrator 的运行截图。*

第二个起因，是我观察到KimiCode 在 Kimi K3 驱动下，在处理事情时通常会先列出 TODO LIST，再开始执行。对于复杂、持续时间长、容易漏步骤的任务，先把目标、依赖、动作、验证和收尾写清楚，再逐项推进，能明显提高过程稳定性。

于是，我想在我用的其它 Agent 中也能多并发+TODO LIST，然而并不是所有 Agent 都可以自由启动大量 subagents，也不是所有 Agent 都会用TODO LIST干活。因此，一个通用的替代办法就是调用它已经安装好的 CLI，打开多个 TUI 窗口并行执行。多个窗口各自运行一个独立任务块，效果与同时启动多个 subagents 接近，但不要求宿主 Agent 本身具备子代理编排能力。TODO LIST 则由技能约束和执行协议固定下来：主控先保留完整原始任务，窗口内再按块列清单、写检查点、逐项更新状态。

诚实地说，这两个能力对简单小活属于杀鸡用牛刀，所以这个编排器从来不是为了让所有请求都弹窗。它的目标是让 Agent 在复杂长任务中稳定使用 TODO LIST；能安全并行的部分，以至少两个 TUI 窗口同时执行；可打开的窗口数由"剩余可用内存 MB ÷ 1000 取整后 × 2"计算最大并发限制数。若请求只有一个任务、只有一个块，或依赖关系决定它只能串行，编排器就不触发开窗机制，由发起 Agent 在当前对话中直接处理。若任务多于窗口上限，多出的任务会并入某个已有块串行完成，最终账本必须覆盖每一项原始任务。

## 具体实现思路

### 1. 先确认工作区和资源容量

编排器从调用进程的当前目录或 `--workspace` 确定工作区，先创建并使用该工作区下的 `temp/orchestrator` 作为状态之家。随后读取本机**剩余可用内存**，按 `floor(剩余可用内存 MB ÷ 1000) × 2` 计算窗口容量（不低于 1）。容量是整个用户会话的共享上限，活动窗口和正在启动的预留窗口都会计入。

### 2. 建立不可丢失的原始任务账本

主控先按请求边界建立 `T001`、`T002` 等稳定任务 ID，保留每一项原文，并把它们作为 TODO LIST 的权威来源。规划模型只能补充项目归属、资源提示、依赖和可行性判断，不能凭“已完成”或“不可行”标记删除任务，也不能用摘要替换原文。模型输出缺项、重复、格式错误或无法确认归属时，系统保留完整原始清单并采用串行安全计划。

### 3. 把语义判断和确定性分块分开

规划阶段只让模型做扁平任务定性：任务是什么、属于哪个项目、会碰哪些资源、依赖哪些任务。真正的分块由代码完成：

- 同一项目或同一资源目录的任务归到同一块，避免互相覆盖。
- 同项目任务再做精细化拆分：分类器为每个任务给出精确资源关键词（conflict_hints）时，按资源键重叠聚类——互不重叠的任务各自成块并行开窗（只带精确资源键，不再共用项目目录键）；任一任务说不清资源或全部纠缠时才退回单块串行（项目目录键兜底）。
- 明确没有冲突且没有依赖的任务保留为独立块。
- 未知归属的任务进入保守的串行块，不把孤儿任务误放进并发波次。
- 依赖关系先校验未知、自指和循环，再映射到块级依赖。
- 同一波次只启动依赖已验收的块；无关块不互相排队。

### 4. 应用容量上限，而不是制造额外队列

确定性计划完成后，按容量压缩块数。压缩只会把任务合入已有块，并把合并块标记为 `linked`（块内严格串行）；它不会产生第 9 个窗口，也不会把剩余任务悄悄推迟到下一轮。压缩前后都检查原始任务 ID 集合，确保数量、唯一性和顺序可追溯。

### 5. 用并行波次决定是否开窗

代码会把计划转换为依赖波次，并应用明确的开窗策略：

- 只有一个块：返回 `mode: inline`，不创建运行窗口。
- 多个块但每个波次只有一个块：返回 `mode: inline`，不为串行链打开窗口。
- 某个波次至少有两个块：返回 `mode: windows`，按该波次并行启动至少两个 TUI 窗口；同一波次的实际数量仍不能超过内存容量。

`inline` 返回中包含原始请求、完整任务账本、块标题、依赖和下一步提示，因此“不开窗”不会变成“任务没执行”或“任务被吞掉”。

### 6. 在 Windows Terminal 中启动失焦窗口

每个块获得唯一运行 ID、尝试编号和 token（本次窗口的唯一结束标识）。Windows Terminal 负责承载可见界面，启动时继承发起工作区和已授权的宿主参数；分离式启动器不会主动把新窗口置前。若 Windows Terminal 不可用，才退回传统控制台承载，不会退回另一个 Agent。关闭时只根据已核对的 launcher（启动器）进程身份处理自己的进程树，不结束共享的 Windows Terminal 主进程。

### 7. 在每个窗口内固定 TODO 和执行纪律

窗口启动后先检查环境并列出本块 TODO LIST，保留原始任务 ID、目标、依赖、动作、验证和收尾。每项开始前写入 `started` 检查点，完成并自验后写入 `completed` 检查点；失败就保留现场证据，不把口头汇报当成成功。窗口不得再次调用编排器、不得递归开窗，也不得把其它任务混入本块。

### 8. 通过多重证据判定完成

窗口最后输出带自身 token 的 `__ORCH_DONE__` 标记，watchdog（完成监视器，在窗口异常退出前持续观察收尾证据）据此自动收尾。但结束标记只表示窗口完成了自己的收尾动作，不表示业务结果一定正确。主控还要：

- 读取每个块的检查点和结果文件。
- 按父级提供的只读验收条件核对真实落盘文件、JSON 或命令结果。
- 确认所有原始任务都有最终状态。
- 确认窗口进程已经关闭且租约已释放。
- 只有全部任务 `verified` 才把整批标记为成功。

### 9. 中断恢复和幂等保护

每次尝试都把剩余任务 ID、工作区、token、PID（进程标识）和启动文件写入运行账本。恢复时先按进程身份、创建时间、可执行文件和命令行接管仍存活的窗口，不重复启动替代窗口。已经验收的任务不会重做；已开始但副作用无法证明的任务进入 `needs-reconciliation`（需要主控核对实际状态），不会盲目重跑。依赖失败的后续任务保留在账本中并明确阻塞原因。

### 10. 以适配器隔离不同 Agent

通用入口通过 `--agent` 或 `ORCH_AGENT` 选择宿主；两者都缺省时，先按宿主环境标记（`CODEX_THREAD_ID`/`CODEX_SESSION_ID`），再按 Windows 祖先进程链（kimi.exe / codex.exe / claude.exe / pi-coding-agent / opencode / openclaw，就近命中）自动识别发起方。Codex、pi、opencode、Kimi Code、Claude Code 和固定版本 OpenClaw 各自实现参数拼接、会话/结果读取、完成判定和关闭流程；通用调度器只依赖统一协议。新 Agent 必须同时通过 CLI 发现、规划、交互启动、输出解析、完成和清理验证，不能只添加一个命令名。

### 11. 弱网和无二次确认执行

Codex 规划和窗口沿用现有 HTTPS Responses 配置，避免先等待 WebSocket 再回退；网络暂时中断时由宿主 CLI 的重试和截止时间处理，状态写入工作区账本。已授权窗口直接开始工作，不重复要求人工确认；编排器只传递调用方已经拥有的权限，不把自身变成权限提升工具。

### 12. 清理、发布和验证

运行结束后只清理本批已结束且由本批拥有的启动器、日志、结果和临时文件，保留运行账本和必要验收证据；活动窗口及其它工作区状态不会被误删。核心文件用 `release.json` 的 SHA-256 发布封印（固定发行清单的完整性校验）保护，核心或运行时变更后必须重新封印并验证。

### 13. 维护锁：自身维护期间暂停编排

对编排器自身做升级/优化/维护/更新等改动前，先上维护锁：`node scripts/maintenance-lock.mjs lock --reason "原因" [--ttl-minutes N]`。上锁期间任何 agent 调用编排器的动作入口（`orch`、`--run-windows`/`--spawn`/`--resume-run`/`--run`/`--exec`/`--plan`、`open-tui-orchestrator-preflight.mjs`、`open-tui-orchestrator-force.mjs --assert/--verify`）都只返回一句话：`open-tui-orchestrator正在维护更新，本轮跳过orchestrator直接开始执行`，并以退出码 0 放行，由发起对话本轮直接执行。只读入口（`--status`/`--doctor`/`--verify-run`/`--clear-cache`/`--tasks`）不受影响，`--status` 会额外显示锁状态。锁全局按用户生效（默认 `~/.open-tui-orchestrator/maintenance-lock.json`，可用 `ORCH_MAINTENANCE_LOCK` 覆盖），默认 180 分钟自动过期（上限 24 小时），过期或文件损坏一律 fail-open 视为未锁，绝不会把编排器卡死；`repair.mjs --clean`/`--target` 在未持锁时会自行上锁、结束即解。维护结束用 `node scripts/maintenance-lock.mjs unlock` 解锁。

## 相关文档

- [执行与验收协议](docs/execution-contract.md)
- [发行策略](docs/release-policy.md)
- [Pi 适配说明](docs/pi-adapter.md)
- [OpenClaw 执行与隔离说明](docs/openclaw-adapter.md)
- [Kimi Code 适配器](docs/kimi-adapter.md)
- [opencode 适配器](docs/opencode-adapter.md)
- [Claude Code 适配器](docs/claude-adapter.md)
- [新 agent CLI 自动适配（print-class 画像）](docs/adapt.md)
- [调用方自助通道：计划文件 + 单元命令（任何 agent）](docs/caller-driven.md)
- [Kimi Code 接入：看板流 → 原生 TodoList](docs/kimi-integration.md)
- [失焦窗口验证](docs/inactive-windows.md)
- [异常中断后自动恢复](docs/auto-recovery.md)
- [维护锁](docs/maintenance-lock.md)

## 当前支持与验证边界

Codex CLI、pi CLI、opencode CLI、Kimi Code CLI、Claude Code CLI 和 OpenClaw 2026.9.2 CLI 已完成适配。运行诊断：

~~~powershell
node cli.mjs --agent codex --doctor
node cli.mjs --agent pi --doctor
node cli.mjs --agent claude --doctor
node cli.mjs --agent openclaw --doctor
~~~

当前通用核心为 1.16.5，离线回归为 336/336 通过；覆盖无窗 headless 派发默认（`--mode window` 保留可见弹窗；launcher/身份/租约/恢复契约同构，隐藏载具不抢焦点）、单元载体分级（TUI 类 agent 走 ConPTY 伪终端载体——真实控制台、无窗口、不抢焦点，身份/租约/恢复契约与窗口模式同构；print 类维持无控制台载体）、执行看板（块与任务状态实时 `[board]` 行、run `events.jsonl`、只读 `--watch <runId>` 流式视图含 `--jsonl`、`--status` 活动 run 摘要）、任务不丢失、内存拟合动态并发（按宿主的单元内存画像学习；“合并到放得下”并保 256MB 底线）、依赖波次、同项目任务按资源键精细化拆分、全局容量租约（排队块等待指数退避+抖动；`ORCH_WAIT_BACKOFF_MS`/`ORCH_WAIT_BACKOFF_MAX_MS` 可调；协调器互斥等待亦可调可重试：`ORCH_MUTEX_WAIT_MS`/`ORCH_MUTEX_RETRIES`，锁票按龄回收 `ORCH_MUTEX_TICKET_TTL_MS`）、Windows Terminal 启动（同步拉起，弹窗可靠且不抢发起窗焦点）、失焦启动回归、进程身份、断点恢复、恢复账本加固（launcherFiles 工作区包容、验收契约哈希绑定、注册表锁老化回收）、守护进程驱动的控制器丢失自动恢复（test/guardian-live-result.json）与手动 --resume-run 收编存活窗口恢复（test/recovery-live-result.json）、发起方自动识别（环境标记优先、进程链兜底：kimi/codex/claude/pi/opencode/openclaw/hermes）、`orch` 强制编排入口、print-class 数据驱动画像适配管线（表面探测→画像→解析自检→活验守门→重封→自动提交，失败一律回滚；画像 agent 按 `modelDetection` 跟随发起窗 model/effort；hermes 画像已落地——hermes 发起即自动挡：识别其身份并以自身 CLI 执行（`--no-restore-cwd` 防旧会话 CWD 写偏））、调用方自助通道（调用方自带计划文件在覆盖/依赖/回退保证不变的前提下跑通且全程零模型调用、调用方自带单元命令让任意 CLI 走同一启动器/租约/恢复/验收契约、只读 `--tasks` 账本助手、单元命令的 resume 身份一致性、未知 agent 的两条出路诊断）、档位去向留痕（summary 记录 model/effort 与三态来源：explicit/宿主会话/host-default；机器可读入口 stdout 保持纯数据）、机器可调用失败契约（公开入口失败一律只回一行 `[orchestrator] FATAL: <原因>`、无 Node 栈帧（`ORCH_DEBUG=1` 才打）；未知 run 不甩 `ENOENT`、不挂起——`--verify-run`/`--resume-run` 立刻回 `Run not found: <id>`，`--watch` 先给有界宽限 `ORCH_WATCH_GRACE_MS`（默认 60s，覆盖 `--run-windows` 仍在规划、run 目录尚未建立的竞态）再拒，看板中途丢 `summary.json` 也立刻报错而不静默停摆）、维护锁、当前核心安全审计及修复（docs/security-audit-2026-09-09.md）、弱网配置、SDK 诊断、宿主 CLI 探测超时重试与逐候选拒绝诊断、OpenClaw 版本门诊断（tui 接口探针先行：未验证版本以探针实测结果 + 最后验证版本 fail-closed——版本常量只记「最后验证于」，不是准入门槛）、恢复账本校验覆盖盘符根工作区和干净发行副本。测试环境要求：离线套件假定发起 agent 的 CLI（默认 `codex`）可在 PATH 解析（Windows 下前置 codex vendor bin，即回归环境约定）；缺失时依赖 agent 解析的测试文件按设计快速失败（fail-closed），其中两个运行期依赖 CLI 的用例已标注 `{skip}`。真实模型额度、不同 Windows 用户安装、长时间断网恢复和每个未来 Agent 的现场兼容性也仍需单独验收。

未知宿主、无可执行 CLI 或显式路径无效时，命令会直接失败并给出原因；不会自动安装、猜测替代路径或换用其它 Agent。
