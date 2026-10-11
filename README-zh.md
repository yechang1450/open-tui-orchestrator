# open-tui-orchestrator

面向 Agent CLI 的本地 Node.js 编排器：把复杂请求拆成**无损失、可验证**的任务账本，并按你机器**实际可让出的内存**并发运行其中的并行块——每块一个 TUI 窗口。

> 项目文档：[贡献指南](CONTRIBUTING.md) · [安全政策](SECURITY.md) · [行为准则](CODE_OF_CONDUCT.md) · [Issue 模板](.github/ISSUE_TEMPLATE) · [PR 模板](.github/pull_request_template.md)

**当前仅支持 Windows。** 启动器、隐形 ConPTY 载体与全机协调器都是 Windows 专属；其他平台会得到明确的诊断而不是一个"半能用"的安装。运行前请先读 **[docs/trust-and-safety.md](docs/trust-and-safety.md)**——它如实说明这个工具会在你的机器上做什么（用你的凭据运行的隐藏 Agent、Codex 宿主运行的免审批模式、具体写入哪些文件）。安全报告渠道：[SECURITY.md](SECURITY.md)。

## 它做什么

- **无损失账本优先。** 任何请求在分析之前先被完整盘点为稳定 ID（`T001…`）；不会因为模型说"已完成/不可行"就丢掉任务，摘要永远不能替代原始描述。
- **语义分类 + 确定性规划。** 模型负责分类：任务归属、资源与依赖；确定性代码负责校验覆盖面、拒绝不安全的依赖边、排出依赖波。模型输出缺失或畸形时，回退为仍然覆盖全表的串行安全计划。
- **只在值得时才并行。** 只有当某一波里至少有 2 个就绪块时才开窗；单任务、单块计划、纯串行依赖链都留在发起对话里内联执行。跳过窗口从不意味着丢掉任务。
- **内存适配容量。** 单元默认 headless：同一个启动器跑在隐形载体下，不弹窗、不抢焦点（`--mode window` 保留可见窗口）。同一波内，预计最重的块先启动。

```text
单机单元内存估算 = p90(实测单元峰值) × 1.3   （样本不足 3 个时回退到 640 MB 默认值）
可容纳单元数     = floor((可用内存 MB − 1000) / 单元估算)
```

`ORCH_MIN_FREE_MEM_MB` 设定保留下限（默认 1000 MB）；刻意使用**可用**内存（而非总量）。超出容量的任务合并进串行块并保留在账本里——绝不推给隐藏队列、绝不删除。跨运行协调器确认活动窗口数；活动窗口与启动中的预留都占用容量。

- **要证据，不要口头声明。** 每个窗口为它的块打印完整 TODO 清单，写 `started`/`completed` 检查点与 token 专属的 `__ORCH_DONE__` 标记；看护进程加上父级的验收条件，核实真实文件、命令输出、进程关闭与租约释放。**每个任务都 `verified` 时，整轮才算成功。**
- **可恢复，但不盲目重放。** 中断的运行会按 PID / 创建时间 / 可执行文件 / 命令行认领存活的窗口；已开始但副作用无法证明的任务会变成 `needs-reconciliation`（交给人核实真实状态），而不是被盲目重放。停滞单元（证据停止推进超过 `ORCH_UNIT_STALL_MS`，默认 600000 ms）会被关闭并在块的尝试预算内重试；`ORCH_UNIT_TIMEOUT_MS`（默认 2700000 ms）限制单个单元的最长寿命。
- **五种宿主、一套契约。** Codex、pi、opencode、Kimi Code、Hermes Agent 的适配器在共享契约之下分别实现参数构造、会话/结果读取、完成检测与关闭。宿主由 `--agent`/`ORCH_AGENT`、宿主环境标记、或从 Windows 祖先进程链推断发起方选定。未知宿主、未验证 CLI、可执行文件缺失都会给出诊断——**不自动安装、不静默回退到其它 Agent。**

运行状态（启动器、锁、结果、账本）在你工作区的 `temp/orchestrator` 下；你的 Agent 自己的配置、会话与凭据仍在原位置。编排器只会转交调用者已有的权限，绝不充当提权层。

## 安装

```powershell
npm install -g open-tui-orchestrator
open-tui-orchestrator --install-deps          # 拉取本包锁定的 SDK 依赖（联网一次）
open-tui-orchestrator --agent codex --doctor  # 自检：hostError null、carrierAvailable true
```

要求：Windows 10/11 (x64)、Node.js 22+、Windows Terminal（推荐）、以及一个你**已经在用且已登录**的 Agent CLI——Codex / pi / opencode / Kimi Code / Hermes Agent 之一。本工具从不安装或代替 Agent CLI。tarball 安装、源码安装、升级/回滚、卸载与排障见 **[INSTALL-zh.md](INSTALL-zh.md)**（英文: [INSTALL.md](INSTALL.md)）。

## 适用场景

适用于：一个请求横跨多个项目/目录、包含彼此独立的修复、或"前置步骤 + 长验证与清理"相结合的任务。对于小操作、单一操作、纯串行链或只读分析，当前的 Agent 本身就是更好的执行面——这些留在发起对话里。`--spawn` 是"开一个可见窗口"的显式入口。

## 快速开始

请在"应当归属该次运行"的工作区里执行命令，不要切到安装目录。示例假设 `cli.mjs` 在当前命令路径中；必要时替换为绝对安装路径：

```powershell
node cli.mjs --agent codex --doctor
node cli.mjs --agent codex --workspace 'D:\your-project' --plan '修复 81 项目登录页并优化 82 项目购物车'
node cli.mjs --agent codex --workspace 'D:\your-project' --run-windows '修复 81 项目登录页并优化 82 项目购物车'
node cli.mjs --tasks '修复 81 项目登录页；优化 82 项目购物车'
node cli.mjs --plan-file plan.json --unit-cmd-file unit.json --run-windows '修复 81 项目登录页；优化 82 项目购物车'
```

`--plan` 只做规划；新的 `--run-windows` 仅在存在并行波时才开窗；`--resume-run <id>` 在中断后认领已保存的运行；`--verify-run <id>` 只复核不执行；`--status --readonly` 报告窗口、租约与活动运行；`--watch <id> [--jsonl]` 只读流式输出运行看板；`orch` 是强制执行入口——绕过一切内联回退（维护锁除外）。任何 Agent 都可以**不装适配器**直接调用：`--plan-file` 接收调用方自己的账本/分块（全程零模型调用），`--unit-cmd`/`--unit-cmd-file` 提供单元命令——见 [docs/caller-driven.md](docs/caller-driven.md)。接入新的 print 类 CLI：`node scripts/adapt.mjs`——见 [docs/adapt.md](docs/adapt.md)。维护编排器自身时，`node scripts/maintenance-lock.mjs lock --reason "为什么"` 会暂停一切动作入口直至解锁——见 [docs/maintenance-lock.md](docs/maintenance-lock.md)。

## 为什么做这个

两个源头。其一：让有能力的模型用满它的宽度——某次大型代码评审中，Kimi K3 指挥 KimiCode 一次性派出 10 个 coder 子代理，并行执行在大任务上的吞吐收益一目了然。

![KimiCode 一次派出 10 个 coder 子代理](docs/assets/kimicode-agent-swarm-10-subagents.png)

*图：KimiCode 由 Kimi K3 驱动，一次派出 10 个子代理——这是"并行窗口"动机的参考图，不是 open-tui-orchestrator 的截图。*

其二：观察到 Agent 开始复杂工作时先写 TODO LIST。对容易漏步骤的长任务，执行前记录目标、依赖、动作、验证与清理，会让过程可靠得多。不是每个 Agent 都能自由派子代理；一个通用替代法就是驱动它已装好的 CLI，并行开几个 TUI 窗口——每窗一个独立块，账本由执行契约兜底。

## 支持的宿主

Codex CLI、pi CLI、opencode CLI、Kimi Code CLI、Hermes Agent 均已接入适配器。诊断：

```powershell
node cli.mjs --agent codex --doctor
node cli.mjs --agent pi --doctor
node cli.mjs --agent hermes --doctor
```

未知宿主、CLI 缺失或显式路径无效都会给出诊断。

## 验证状态

当前通用核心为 0.9.24-1，离线回归为 511/511 通过。本机发布的判定器是 `node scripts/gate.mjs --all`——L1 离线套件、L2 宿主解析 + 反例能红（判据本身没坏）、L3 未知 run 干净失败、L4 版本/封印/文档/套件总数对账。任何核心或运行时文件变更都必须重新 `release-integrity --seal`。细节与证据：[docs/release-policy.md](docs/release-policy.md)。

## 相关文档

- [执行与验收契约](docs/execution-contract.md)
- [发布政策](docs/release-policy.md)
- [信任与安全](docs/trust-and-safety.md)
- [pi 适配器](docs/pi-adapter.md) · [Kimi Code 适配器](docs/kimi-adapter.md) · [opencode 适配器](docs/opencode-adapter.md)
- [新 Agent CLI 的自动适配（print 类画像）](docs/adapt.md)
- [调用方驱动执行：plan 文件 + 单元命令（任意 Agent）](docs/caller-driven.md)
- [Kimi Code 集成：看板流 → 原生 TodoList](docs/kimi-integration.md)
- [无焦点窗口验证](docs/inactive-windows.md) · [异常中断后的自动恢复](docs/auto-recovery.md) · [维护锁](docs/maintenance-lock.md)
