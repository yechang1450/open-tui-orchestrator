# 安全审计报告（2026-09-09，当前核心复扫）

审计对象：当前工作树核心（CORE_VERSION 1.7.0，`release.json` 封印 31 核心文件 + 49 运行时文件）。
方法：双路独立 LLM 源码审计（引擎/注入面 + 适配器/脚本/凭证面），等价于 2026-09-05 的「Codex Security 标准审计」做法（官方 Codex Security MCP 工具在本环境不可用）。
威胁模型：本机单用户工具，输入来自本地调用方；窗内 agent 以用户全权限运行且工作目录即工作区。

## 基线复验（2026-09-05 结论在当前源码上全部仍成立）

- 无 shell 注入：全部 `spawn/spawnSync` 为数组参数 + `shell:false`，无 `exec/shell:true`。
- 生成的 ps1 无插值注入：提示词全程走文件（writeFileSync + Get-Content 读回），路径单引号转义、token 限定字符集、PID 数值校验。
- config.toml 只读 model/effort 两个标量（拒收含空白/引号的值），不打印凭证；全仓库无凭证文件读取。
- PID 复用防护到位：进程身份四元组（ProcessId+Started+Name+CommandLine）+ launcher 命令行须含预期脚本路径。
- 完成判定 fail-closed：持久检查点 + 验收双闸；窗内汇报文本不是成功证明；无验收检查时停在 awaiting-verification。
- 供应链：无远程下载执行路径；唯一依赖由 package-lock 完整性哈希锁定；CLI 解析逐个真实执行能力探针。

## 发现与处置

### 已修复（Medium ×4 + Low ×1）

| 编号 | 问题 | 修复 |
|---|---|---|
| A-M1 | 裸名 `powershell.exe`/`where.exe`/`tasklist` 按进程 cwd（=任意工作区）解析，在不受信目录运行构成二进制投毒 | 统一走 `contracts.mjs` 新增 `powershellExe()/systemToolExe()` SystemRoot 锚定（leases/inactive-window/orchestrate-sdk/force 共 11 处调用点），窗内 WT argv 同步锚定 |
| E-M1 | resume adopt 信任账本 `launcherFiles`，cleanup 可被借手删除任意文件 | `validateRecoverySummary` 增加 launcherFiles 工作区包容校验；cleanup 钩子不信任账本路径，只删工作区内文件（双层） |
| E-M2 | run 目录可写的 acceptance.json 在 resume/verify 时被回读，`command` 类检查以控制器权限执行 | 创建时把验收契约 sha256 锚定进账本（`acceptanceSha256`），resume/verify 回读先比对，篡改即拒绝 |
| E-M3 | 注册表文件锁 stale 后永久降级：每次操作 2s 事件循环忙等 + 静默失去互斥 | 锁带 owner+时间戳，超龄（60s）安全回收；争用失败时告警而非静默降级 |
| E-L1 | 维护锁 expiresAt 缺失/非数字时永久锁死，违背自身 fail-open 契约 | 非数字 expiresAt 一律视为损坏锁：fail-open 并顺手清理 |

### 登记为已知问题（Low，同用户/窗内 agent 前提，不阻断 RC）

- 拆块缓存未带密钥认证，理论可投毒为未来请求注入附加指令（需精确预测请求全文；攻击者本就同权限）。
- `--verify-run` 信任账本 coordinator 字段，可被重定向建目录（同用户前提）。
- guardian.json 身份字段可被语义伪造以压制自动恢复（DoS 面，重启预算有界）。
- 账本/检查点/验收文件同目录自洽伪造的理论残余（根因：控制面状态在窗内 agent 可写目录；需「创建签名+消费校验」的统一治理，属架构级后续项）。
- 发行封印可被本机同用户写者重封——封印按文档定位是完整性绊线而非防篡改控制，不对外宣称防伪造。
- 窗口日志/结果文件可能沉淀 agent 输出中的敏感内容（temp 目录视同机密；无脱敏）。
- openclaw 隔离配置的 0o600 在 Windows 无效；不匹配密钥名正则的自定义字段仍明文落 temp。

## 总体结论

本轮审计在当前核心上**无 Critical/High**；4 个 Medium 与 1 个 Low 已修复并随新测试回归（修复：8 个源码文件；测试：orchestrator/recovery-ledger/recovery-runtime/maintenance-lock/inactive-window 五个测试文件）。
本报告 + 对应修复提交 + 当次封印哈希三者共同构成**当前核心的新安全基线**，替换 2026-09-05 绑定旧哈希的历史基线。
