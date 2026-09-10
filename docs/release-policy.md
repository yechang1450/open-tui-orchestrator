# Release policy

本项目按独立 Node CLI 发布。`release seal`（发布封印，用 SHA-256 固定可执行文件清单）写入根目录 `release.json`，公共编排入口和轮询入口在加载引擎前都会验证它。封印为 schema 2，覆盖当前通用核心、CLI、运行时脚本和已锁定的 SDK 入口；Git、依赖目录、工作区 `temp`、覆盖率和开发缓存不会进入发行包。

维护和发布按下面顺序进行：

1. 确认没有正在运行或等待回收的编排窗口；运行中的账本属于工作区 `temp/orchestrator`，不能当作发布缓存清理。
2. 在源码目录执行完整回归：`node --test test/*.test.mjs`。
3. 核心或运行时变更后重新生成并验证封印：`node scripts/release-integrity.mjs --seal`，随后执行 `node scripts/release-integrity.mjs`。
4. 用 `node repair.mjs --target <新的绝对父目录>` 生成发行副本。目标目录必须不存在；复制完成后会再次验证封印和必需文件，任何失败都会清理本次 staging 目录。
5. 从目标副本运行 `node repair.mjs`、`node cli.mjs --agent codex --doctor` 和只读状态检查，再交给实际安装器或插件管理器做激活、升级和回滚。

当前源码封印记录通用核心 1.7.2、32 个核心文件和 50 个运行时文件。最新离线回归为 223/223 通过；当前已覆盖任务不丢失、多块并行容量调度、依赖波次、单块/纯串行计划不触发普通开窗、同项目任务按资源键精细化拆分并行（资源不明则整组串行兜底）、全局容量租约、Windows Terminal 启动（同步拉起，弹窗可靠且不抢发起窗焦点）、进程身份、断点身份、损坏账本拒绝、账本 launcherFiles 工作区包容校验、验收契约创建时哈希锚定（resume/verify 篡改即拒）、注册表锁老化回收、轮询截止时间、SDK 缺失诊断、宿主 CLI 探测超时重试与逐候选拒绝诊断（scripts/core/host-probe.mjs）、恢复账本 launcherFiles 包容校验覆盖盘符根工作区、发起方进程链自动识别（kimi/codex/pi/opencode/openclaw 就近命中）、kimi 与 opencode 适配器的启动器回环、控制器异常死亡后的守护进程自动接管恢复（test/guardian-live-result.json）与手动 --resume-run 收编存活窗口恢复（test/recovery-live-result.json）、维护锁（自身维护期间动作入口只回固定话术并放行，docs/maintenance-lock.md）和干净发布副本。2026-09-09 已完成当前核心安全复扫（双路 LLM 源码审计，docs/security-audit-2026-09-09.md）：无 Critical/High，4 个 Medium 与 1 个 Low 已修复并纳入回归，其余 Low 登记为已知问题；该报告、对应修复提交与本次封印共同构成当前核心的新安全基线，替换 2026-09-05 绑定旧哈希的历史基线。长期环境验收仍单独列为发行门槛。覆盖率摘要保存在 `coverage/coverage-summary.json`，它是验证产物，不会随发行副本发布。

Codex、pi 和固定版本 OpenClaw 适配器各自负责宿主参数、会话输出、完成判定和关闭流程。Windows Terminal 是默认可见承载；PowerShell 只作为生命周期脚本和进程枚举辅助，不承担宿主适配。没有经过对应适配器验证的 CLI 会直接失败，不自动安装或回退到其它 Agent。

本机离线和包级检查不能替代外部验收。仍需用当前封印逐项补证的项目包括：当前模型额度下的八窗口九任务实跑及合并块串行、干净 Windows 用户安装、实际插件管理器激活升级回滚、长时间断网后的重连与收尾、TUI/控制器终止后的清理，以及 Windows 重启后的恢复。控制器中断后的接管和恢复已于 2026-09-09 双路径补证：守护进程自动 `--resume-run` 接管存活窗口（test/guardian-live-result.json），以及手动 `--resume-run` 收编存活窗口、generation=2、attempts=[1,1]、首任务零重跑（test/recovery-live-result.json）。完成其余项目并保留机器可读证据后，才能把当前候选称为广泛稳定发行版。
