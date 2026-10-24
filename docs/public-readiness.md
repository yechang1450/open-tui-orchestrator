# 公开可用性差距清单（2026-09-14）

> **当前状态（2026-10-13）**：仓库包版本为 `26.10.13-3`，封印核心版本为 `0.9.24-1`（以 `package.json` 与 `release.json` 为准）。GitHub Actions workflow 已按仓库决策保留为 RETIRED（不上膛）；dependabot 配置已随公开前清理移除（不再自动开 PR）。当前发布判断以本机 `node scripts/gate.mjs --all` 为准。本文其余带日期、版本号和测试数量的条目是推进记录；除非明确标注当前状态，不应当作今天的运行结果。


目标：让**外人**装得上、跑得起来、看得懂。每条都有验证方式；状态只有三种：**已具备** / **待补** / **需你决策**。

## 一、已经具备（都有现场证据）

| 项 | 证据 |
| --- | --- |
| 作者署名与全权保留声明 | `README.md` 与 `README-zh.md` 的 Copyright 节 |
| 离线回归全绿 | 296/296（本轮补 2 条：`scripts/gate.mjs` 自身可红判据；Windows-only 入口拒绝判据——判据本身已用「去守卫 + 重封副本」验证能红；2026-09-15 再补 3 条：封印树「链接拒绝」判据——红例用「摘掉链接检查 + 类型白名单」实测能红；身份枚举失败话术必须带预算/耗时/出路——红例＝把话术改回裸串即红；2026-09-16 再补 1 条：gate 必须报告本壳 `ORCH_SPAWN_MODE` 且子进程钉 headless——红例＝改动前无报告行即红，且本壳设 `window` 时旧版四条断言真红；2026-09-17 再补 1 条：门禁 L1 红名单——reporter `✖ failing tests` 区点名＋`[gate] suite reds` 机读行＋全量输出落 `temp/gate-suite-*.log`，判卷记录带 `suite_reds`；红例＝解析器退化回空/对无标记文本编造即红） |
| 发行封印 + 副本流程 | `release.json`（43 核心 + 65 运行时）、`repair.mjs`、`docs/release-policy.md` |
| 机器可调用失败契约 | 一行 `[orchestrator] FATAL: …`、退出码 0/1/2、未知 run 不挂起（1.13.0 起） |
| 机判门禁（在仓里，任何人可跑） | `node scripts/gate.mjs --all`：L1 套件 / L2a doctor / L2b 反例能红 / L3 未知 run / L4 版本·封印·文档·套件总数对账 + 锁票巡检 |
| Windows-only 承诺**已强制** | **2026-09-15 新增** `scripts/platform-guard.mjs`（`cli.mjs`/`orch.mjs`/壳层三入口，早于解析宿主/调模型/落状态）；判据 `test/windows-only.test.mjs` 且红例真做（副本去守卫+重封 → 假平台健康 exit 0） |
| 发布件真机执行验收 | **2026-09-15 实测** 0.9.4 副本经调用方自助通道双块并行：`2/2 verified finalized success=true`、产物落盘并记 sha256、检查点 completed，~60 秒（零模型调用） |
| 安全审计（当前核心） | `docs/security-audit-2026-09-09.md`（无 Critical/High；Medium/Low 已修或登记） |
| 一键补依赖 | **本轮新增** `--install-deps`：幂等、失败干净、stdout 纯数据、从不碰 agent CLI |
| 安装路径实测 | `npm pack`（403 kB / 162 文件）→ 装进独立前缀 → `--install-deps`（3 s，npm 缓存）→ `--doctor` `hostError=null` `carrierAvailable=true` |
| 安装文档 | **本轮新增** `INSTALL.md` / `INSTALL-zh.md` + README 安装节 |
| 调用方接入 | `docs/caller-driven.md`（任何 agent 四行接入、`--plan-file`、`--unit-cmd`、`--tasks`） |

## 二、待补（按我的排序；1–3 是硬门槛）

**结论（2026-09-14，core 1.14.4 / 0.9.4）：清单只剩两件事，且都不可逆、都必须用户亲手点——一、发 npm 包（需要 `npm login`/token）；二、仓转公开。其余全部就绪。**

1. ~~公开前的个人路径清理~~ **完成 2026-09-14**：18 个 tracked 文件、77 处用户名归一化为 `<user>`；根因一并修掉（证据采集器、画像适配器、hermes 画像 provenance）。验证：身份扫描结果只剩公开的 GitHub 句柄 `yechang1450`。
2. ~~**npm 发布**~~ **已发布（最新＝0.9.9 · `latest` · 2026-09-17 00:27 +08）**：`open-tui-orchestrator@0.9.9` 已在 registry 上（93 文件 / 315.8 kB、shasum `4dc01c89…`、integrity `sha512-ceuO3vJb…`）。发布前对当轮 HEAD `f1ce647` 复绿：`node scripts/gate.mjs --all` = `ORCH_GATE: PASS — 5 criteria`（295/295）＋ `npm publish --dry-run` 面检同值。账号＝个人账号 unscoped（`npm whoami` = `yechang1450`；正名未被占）。**端到端烟测（0.9.9 · 冷前缀 `D:/temp/orch-coldinstall-099`）**：① `npm install open-tui-orchestrator` → `--version` = `0.9.9 (core 1.14.9)` → `--install-deps` = `{"ok":true,"action":"installed"}`（幂等复跑 `already-present`）→ `--agent codex --doctor` = `hostError=null / carrierAvailable=true`；② `npx --yes open-tui-orchestrator@latest --version` = `0.9.9 (core 1.14.9)`（任何 agent 从 PATH 即装的路径成立）。**历史**：0.9.6 = 2026-09-15 首发（93 文件 / 310.5 kB、shasum `4b16de76…`）。
3. ~~CI~~ **弃用（用户令 2026-09-15）**：GitHub Actions 一律不用——私有仓被账户计费拦死（2026-09-15 实测：作业零步骤、3 秒失败），转公开也不再启用。**判定全部走本机等价门禁**：`node scripts/gate.mjs --all`（一条命令五判据 + 反例能红）＋ 定时巡逻（schtasks 法，需要时并入）。`.github/workflows/ci.yml` 仅作历史记录保留、不带任何触发。
4. ~~公开文档面~~ **完成 2026-09-14**：`CHANGELOG.md`、`.github/ISSUE_TEMPLATE/bug_report.yml`、`SECURITY.md`（私密漏洞报告渠道 + 披露政策）、`CONTRIBUTING.md`（屋规：判据必须能红、封印纪律、数字对账）。
5. ~~信任与安全声明~~ **完成 2026-09-14**：`docs/trust-and-safety.md`（隐藏 agent 以你的凭据运行、Codex 的 `--dangerously-bypass-approvals-and-sandbox`、`--unit-cmd` 属调用方自授权、写哪些文件、无遥测无后台服务、如何卸载），README/README-zh 首屏与 INSTALL 均给出一行摘要 + 链接。
6. ~~平台声明~~ **完成 2026-09-14**：README/README-zh 首屏与 INSTALL「Requirements」均明写 **Windows-only**，其它平台直接给诊断。
7. **外部首次验收——你的部分**：在一台干净的 Windows 机器/用户上走一遍（装 Node → 装包 → `--install-deps` → doctor → 双块真跑）。`docs/release-policy.md` 已把「不同 Windows 用户安装」列为发行门槛。
   **注意（2026-09-15 环境事实）**：本机 codex 账号额度耗尽（Sep 19 恢复）——模型驱动的真跑今天做不了；编排器在该条件下退化正确（inline 明说、无假成功），调用方自助通道（零模型调用）的真机双块验收已于 2026-09-15 通过。
8. ~~验收证据去本地化~~ **完成 2026-09-14**。
9. ~~公开面示例复查~~ **完成 2026-10-12**：README（中英）快速开始、适配器文档、CHANGELOG 历史条目、工具注释与全部测试夹具清除作者私有项目编号引用，统一改为中性占位（文本用 项目A/项目B，需为数字的项目编号用 07/08）；classify 提示词去掉编号示例；两条验收记录同步清理。（26.10.12 轮，详见 release-policy。）

### 公开前一毫米（done 一件、剩一件可选）
```powershell
# 一、发布 ✅ 已完成（最新＝0.9.9 / latest，2026-09-17 上架；冷装三步 + npx 实跑通过）
#     产物基线：93 文件 / 315.8 kB、shasum 4dc01c89…（0.9.6 = 2026-09-15 首发、310.5 kB）

# 二、转公开（可选：CI 理由已作废，只剩「让外人能看到/克隆源码」一条）
gh repo edit yechang1450/open-tui-orchestrator --visibility public --accept-visibility-change-consequences
# 注意：转公开后**不**武装 CI（CI 已弃用，用户令 2026-09-15）；判定走本机等价门禁 `node scripts/gate.mjs --all`。
```

## 三、需要你决策

**当前只剩一个决定（npm 发布账号那条已随发布定案）：**

- **仓库是否转公开**（private → public）：不可逆；历史里只有作者信息（已清理机器用户名，只剩公开的 GitHub 句柄）。CI 理由已作废（CI 弃用），现在只剩「让外人看到/克隆源码」一个动机——愿意再点。
- ~~**npm 发布账号**~~ **已定 2026-09-15：个人账号 unscoped**（`open-tui-orchestrator@0.9.9` = `latest` 已发布；正名未被占，无需 scope 退路）。

已由我按「最省事且不烧钱」定完、不需要你操心的：平台路线（Windows-only 明说，不投跨平台）、CI（**弃用**——判定走本机等价门禁 `node scripts/gate.mjs --all`，用户令 2026-09-15）、信任声明与安全渠道（`docs/trust-and-safety.md` + `SECURITY.md`）。

## 四、推进记录

1. ~~个人路径清理 + `CHANGELOG.md` / issue 模板~~ ✅ 2026-09-14
2. ~~`npm publish --dry-run` 预演 + 打包瘦身（`files`）~~ ✅ 2026-09-14（89 文件 / 292 kB）
3. ~~CI 骨架 + 门禁入仓~~ ✅ 2026-09-14（`scripts/gate.mjs` + `.github/workflows/ci.yml`，有意不武装）→ **2026-09-15 用户令：GitHub CI 弃用，判定走本机等价门禁**
4. ~~信任/安全声明定稿 + `SECURITY.md` + `CONTRIBUTING.md`~~ ✅ 2026-09-14
5. 干净环境首次验收（第 7 项）——**你的部分**，过了即可对外说「可以用」
6. ~~0.9.9 上架（`latest` 刷新）~~ ✅ 2026-09-17 00:27 +08：发布前 `gate.mjs --all` PASS（5 判据 · 295/295）→ `npm publish` → registry 回读（`version=0.9.9`、shasum `4dc01c89…`、integrity `sha512-ceuO3vJb…`）＋ 冷装三步（含 `--install-deps` 幂等复跑）＋ `npx` 烟测全绿；证据 `D:/temp/orch-coldinstall-099/npm-publish-099-smoke.log`。

## 发布记录追加：0.9.22-1（2026-09-22 21:12 +08）

- 版本：`open-tui-orchestrator@0.9.22-1`（`latest` 已显式刷新为它）；内容＝当日 6 个修复提交（协调器互斥机制缺陷 / LLM 拆块静默降级 / 测试隔离 / 退出判定 / 采样器把用例读成超时 / CLI 全覆盖），仓库 HEAD `c3727bc`。
- 发布前实测：`npm test` **361/361**（exit 0）、`node scripts/gate.mjs --all` **PASS — 5 criteria**（L4 双轨校验 core=0.9.22-1 sealCore=0.9.22-1、三文档一致 361/361、实测 361）、封印 `schema 2 / 47 核心 + 71 运行时`。
- 包面：99 文件、packed 377.1 kB、unpacked 888.0 kB、shasum `6fe0be6206e9ebf2c638007d7051a7e819aded40`、tag `latest`。
- registry 回读：`npm view` → `version = 0.9.22-1`、`dist-tags = { latest: 0.9.22-1 }`；tarball 直链 HTTP 200（377140 B）；`npx --yes open-tui-orchestrator@0.9.22-1 --version` → `open-tui-orchestrator 0.9.22-1 (core 0.9.22-1)`。
- 注意：包版本从日期制 `2026.9.19-5` 回到 `0.9.22-1`（semver 上低于 2026.x），`latest` 是用 `--tag latest` **显式**刷新的；`0.9.22-1` 带预发布段，npm 要求显式 tag，否则 EPUBLISHPRERELEASE。

## 发布记录追加：0.9.22-2（2026-09-23 23:06 +08）

- 版本：`open-tui-orchestrator@0.9.22-2`（`latest` 已显式刷新为它）；内容＝公开入口 fail-closed 贯通（`--install-deps`/`--help` 先于上下文解析、工作区/spawn 失败契约、坏工作区点名）、`leases.readState` fail-closed（截断/半写点名文件）、验收契约 `ACCEPTANCE_UNREADABLE/INVALID` 点名、plan 文件元素级校验与 `loadJson` ENOENT 歧义治理；仓库 HEAD `7b757ab`。
- 发布前实测：`npm test` **370/370**（exit 0）、`node scripts/gate.mjs --all` **PASS — 5 criteria**（L4 双轨校验 core=0.9.22-2 sealCore=0.9.22-2、三文档一致 370/370、实测 370）、封印 `schema 2 / 47 核心 + 71 运行时`。
- 包面：99 文件、packed 381.8 kB、unpacked 898.3 kB、shasum `f0390578710e447896ce9c1789d7286d2272e438`、integrity `sha512-qKYPWMJtYzC3mnreivb2muI3PDSsVP9onpr2aqj1nWCTqkAsgr++Mef8Tu59yQTR65sKezzPyUlTBQRl2CikyA==`、tag `latest`。
- registry 回读：`npm view @0.9.22-2` → `version = 0.9.22-2`、`dist-tags = { latest: 0.9.22-2 }`；`npx --yes --registry https://registry.npmjs.org open-tui-orchestrator@0.9.22-2 --version` → `open-tui-orchestrator 0.9.22-2 (core 0.9.22-2)`；全局安装已同步 `0.9.22-2`。
- 注意：`0.9.22-2` 带预发布段，npm 要求显式 `--tag latest`；首个 PUT 回 202（processing），约 5 分钟后 registry 生效；npmmirror 同步有延迟（npx/install 需显式 `--registry https://registry.npmjs.org` 或等镜像）。

## 发布记录追加：0.9.24-1（2026-09-24 上午 +08）

- 版本：`open-tui-orchestrator@0.9.24-1`（`latest` 已显式刷新为它）；内容＝公开入口 fail-closed 收口的正式版号（与 0.9.22-2 同内容：引导面先于上下文解析、工作区/spawn 失败契约、`leases.readState` fail-closed、验收契约与 plan 文件元素级校验、`loadJson` ENOENT 歧义治理）；仓库 HEAD `8a19de1`。
- 发布前实测：离线套件 **370/370**、`node scripts/gate.mjs --all` **PASS — 5 criteria**（L4 双轨校验 core=0.9.24-1 sealCore=0.9.24-1、三文档一致 370/370、实测 370）、封印 `schema 2 / 47 核心 + 71 运行时`。
- 包面：99 文件、unpacked 900.8 kB、shasum `2b43596cb831fe16f780956b783677e477c1cf20`、integrity `sha512-tnG5LLNU81+ojOqsdNqt063KMQpQryHrVcXt1tcWBMUZgdxdILy70Fu8z2CeWHHx0UkAEAipNakhKpRCw6z6Hg==`、tag `latest`。
- registry 回读：`npm view` → `version = 0.9.24-1`、`dist-tags = { latest: 0.9.24-1 }`；`npx --yes --registry https://registry.npmjs.org open-tui-orchestrator@0.9.24-1 --version` → `open-tui-orchestrator 0.9.24-1 (core 0.9.24-1)`；全局安装已同步 `0.9.24-1`。
- 注意：`0.9.24-1` 带预发布段，npm 需显式 `--tag latest`；PUT 回 202 后约 5 分钟 registry 生效；npmmirror 有同步延迟。

## 发布记录追加：26.10.11（2026-10-11 晚 +08）

- 版本：`open-tui-orchestrator@26.10.11`（`latest` 已显式刷新为它，`--tag latest`；日版本号体系 = YY.MM.DD）；内容＝恢复第三档（unproven 自动补跑一次）、窗口生命周期收口（正常/异常一律关窗、温柔关三层）、画像探测增强（ANSI 剥离 / 宽列注入 / npm shim 解析 / 安装位探测 / 子命令二级探测）、kimi 适配修复（接受 npm 全局安装的 `.cmd` shim）；仓库 HEAD `80690cf`。
- 发布前实测：离线套件 **511/511**；`node scripts/gate.mjs --all` 分层全绿（L1 / L2a / L2b / L3 + L4）；五家 CLI（codex / hermes / pi / opencode / kimi）真机轮端到端全绿（三文件 + `node --test` 通过）；封印 `schema 2 / 41 核心 + 65 运行时`。
- 包面：92 文件、packed 383.7 kB、unpacked 902.2 kB、shasum `ef06330e05eecec5e43f84500807a6ce507b2f80`、tag `latest`。
- registry 回读：`npm view` → `version = 26.10.11`、`dist-tags = { latest: 26.10.11 }`；`npx -y open-tui-orchestrator@26.10.11 --version` → `open-tui-orchestrator 26.10.11 (core 0.9.24-1)`。
- 注意：`26.10.11` 数值上低于旧日期版本（`2026.9.30-2`），npm 拒绝自动打 `latest`，必须显式 `--tag latest`；首次 PUT 后约 1–2 分钟 registry 生效。
- 同轮清理：3 个 dependabot PR 分支与 dependabot 配置移除（单人仓库）；README 双语瘦身（EN 93 行 / ZH 92 行）；仓内 markdown 相对链接全量检查 61 条、死链 0。

## 发布记录追加：26.10.12（2026-10-12 凌晨 +08）

- 版本：`open-tui-orchestrator@26.10.12`（`latest` 已显式刷新为它，`--tag latest`）；内容＝外来 pi result 防护（等待端核对完成 token，不一致 fail-closed；判据 `test/pi-runtime.test.mjs`）＋ 公开面清理全轮（README 中英快速开始、适配器文档、CHANGELOG 历史条目、`docs/caller-driven.md` 示例计划、工具注释、测试夹具与验收记录统一中性占位：文本 项目A/项目B、编号值 07/08；classify 提示词去固定编号示例）。本轮同时用于刷新 npm 页面——注册表不提供历史版本 readme，旧版示例文案只能由新版本覆盖；仓库 HEAD `088abf7`。
- 发布前实测：离线套件 **513/513**（3 条按平台跳过：本机未安装 kimi/opencode/pi CLI）；`node scripts/gate.mjs --all` = `ORCH_GATE: PASS — 5 criteria`（L1/L2a/L2b/L3/L4 逐层实读；全量两次 + L4 单跑一次）；封印 `schema 2 / 41 核心 + 65 运行时`。
- 包面：92 文件、packed 385.2 kB、unpacked 905.2 kB、shasum `60e68bf6caf8b4ee88110072a246f4ae6103ae42`、tag `latest`。
- registry 回读：`npm view` → `version = 26.10.12`、`dist-tags = { latest: 26.10.12 }`；`npx -y open-tui-orchestrator@26.10.12 --version` → `open-tui-orchestrator 26.10.12 (core 0.9.24-1)`；新版本 readme 实读零旧文案（`project 8x` 命中 0，新中性示例在位）。
- 注意：`26.10.12` 数值上低于旧日期版本（`2026.9.30-2`），仍须显式 `--tag latest`；首次 PUT 后 registry 全量生效约 6 分钟（期间 `npm view` 先 404/旧值，直读注册表可先行确认）。

## 发布记录追加：26.10.13-2（beta 通道，2026-10-12 早间 +08）

- 版本：`open-tui-orchestrator@26.10.13-2`（`--tag beta`；`latest` 不受影响，仍 26.10.12）。内容＝七宿主测试版（Claude Code 适配器复活 + OpenClaw 重建为 print 类驱动官方 `agent --local` 面）＋ GitHub 源安装循环实逮的**封印 CRLF 缺陷修复**（`scripts/package.json`/`scripts/package-lock.json` 工作区字节归一化 LF，封印按 LF 字节重算——修复前 npm 包自洽但任何干净 checkout 的 `release-integrity` 必红）。仓库 HEAD `cf7f6be`（分支 `beta`；master 不受影响）。
- 发布前实测：离线套件 **533/533**（0 跳过：七家 CLI 全部实装）；`node scripts/gate.mjs --all` = `ORCH_GATE: PASS — 5 criteria`（dev 树 + GitHub 全新克隆各一遍）；封印 `schema 2 / 45 核心 + 69 运行时`。
- registry 回读：`dist-tags = { latest: 26.10.12, beta: 26.10.13-2 }`；安装 `26.10.13-2` 后 `--version` = `26.10.13-2 (core 0.9.24-1)`；`--install-deps` 首跑 installed / 复跑 already-present（幂等）；七宿主 doctor 全绿。
- 双通道验收：npm 副本七宿主真机轮全部 success=true、2/2 verified（verify-run 复核 rc=0）；GitHub 克隆七宿主真机轮同全绿（opencode 轮经官方 `--resume-run` 收编 gen=2）；两通道为同一棵 LF 树，克隆侧 `release-integrity` rc=0。
- 注意：预发布版本号（`X.Y.Z-N` 形态）不带 `--tag` 会被 npm 拒发；`-beta.N` 形态不符合本仓 `--version` 输出契约（三处判据钉 `X.Y.Z(-N)?`），勿用。

## 发布记录追加：26.10.13-3（正式版，2026-10-13 上午 +08）

- 版本：`open-tui-orchestrator@26.10.13-3`（`--tag latest`，`latest` 已显式刷新为它）。内容＝七宿主测试版线正式合流：`beta` 6 笔提交经 `--no-ff` 合入 master（合并提交 `00f314a`；合并后树与通过双通道验收的 beta 树逐字节一致），含 Claude Code 适配器复活、OpenClaw 重建为 print 类（官方 `agent --local` 面）、封印 CRLF 缺陷修复。仓库 HEAD `8dbcfbe`（master；`beta` 分支保持 `0f3cff2` 不动）。
- 合并后实测：`release-integrity` rc=0（45 核心 + 69 运行时）；`gate --all` = `ORCH_GATE: PASS — 5 criteria`（L1 533 pass / 0 fail；首跑因机器负载超出默认套件预算被截断 = INCONCLUSIVE，按预算旋钮 `ORCH_GATE_SUITE_TIMEOUT_MS=1800000` + `ORCH_GATE_TEST_CONCURRENCY=2` 重跑全绿，判据未动）；七宿主本地形态真机轮 7/7（claude/openclaw/codex/pi/opencode/kimi/hermes 每轮 RUN_RC=0 + verify rc=0；验收账本：工作区 `temp/otui-audit-20261012/master-rounds/RECEIPT.md`）。
- 包面：98 文件、packed 399.2 kB、unpacked 946.7 kB、shasum `c77e4fb71c6700118d2229b856cc47992497e121`、tag `latest`。
- registry 回读：`npm view` → `version = 26.10.13-3`、`dist-tags = { latest: 26.10.13-3, beta: 26.10.13-2 }`；tarball 直接解包运行 → `open-tui-orchestrator 26.10.13-3 (core 0.9.24-1)`；`npx -y --prefer-online open-tui-orchestrator@26.10.13-3 --version` 同读数（发布后首分钟内 npx 元数据缓存可能仍解析旧值——用 `--prefer-online` 或直读 tarball 复核）；线上 readme 实读 8606 字符、禁用模式命中 0。本机全局安装已更新至 `26.10.13-3`。
- 注意：`26.10.13-3` 仍须显式 `--tag latest`（日版本号数值排序低于旧 `2026.9.x`）；本次传播快——PUT 后约 1 分钟直读注册表即见新版本与新 tag。

## 发布记录追加：26.10.13-4（正式版·瘦身+审计轮，2026-10-13 午间 +08）

- 版本：`open-tui-orchestrator@26.10.13-4`（`--tag latest`，`latest` 已显式刷新为它）。内容＝npm 极限瘦身（发布包只留运行闭包 + 用户文档）＋ 公开面两遍审计（GitHub 安全特性开启、死件退役、发布文档修订、`locateCli` 锚定修复）；仓库 HEAD `44d01eb`。
- 包面：**66 文件**、packed 217.4 kB（−45%）、unpacked 598.3 kB、shasum `f435c6be55dce5054ac9f6757ab8621486e70cc2`、tag `latest`。开发件（gate / force / preflight / todo-list / 测试 shim / auth 模板 / 守卫自测）、`repair.mjs`、`docs/`、`CHANGELOG.md` 不再随包（仅存仓库）；封印面与装机面同构（45 核心 / 60 运行时；`orch.mjs` 首次纳入封印）。
- 发布前实测：离线套件 **531/531**（0 跳过）；`gate --all` = `ORCH_GATE: PASS — 5 criteria`（L1 531 pass / 0 fail）；`release-integrity` rc=0；`--tasks smoke` rc=0；tarball 装机 + claude 真机轮（2/2 verified、复核 rc=0）。
- registry 回读：`npm view` → `version = 26.10.13-4`、`dist-tags = { latest: 26.10.13-4, beta: 26.10.13-2 }`；tarball 直解包运行 → `open-tui-orchestrator 26.10.13-4 (core 0.9.24-1)`（66 文件实点）；`npx -y --prefer-online open-tui-orchestrator@26.10.13-4 --version` 同读数；发布件补充冒烟 `--install-deps` ok、doctor `hostError=null` / `carrierAvailable=true`。本机全局安装已更新至 `26.10.13-4`。
- 附记：`beta` 指针（`26.10.13-2`）删除仍被 npm 403 拒（token 权限粒度；读/发型操作不受影响，通道简化后 beta 已不参与流程）。

## 发布记录追加：26.10.14-1（正式版·画像强化轮，2026-10-14 凌晨 +08）

- 版本：`open-tui-orchestrator@26.10.14-1`（`--tag latest`，`latest` 已显式刷新为它）。内容＝画像两项可选字段（`minVersion` 版本地板、`plannerTimeoutMs` 规划超时预算）＋ 大流程 10 步执行单定稿 ＋ npm 页快照说明；`beta` 分支已同步至 `24e10fd`（测试版线上存档）。仓库 HEAD `60be928`（master 合流提交）；发布提交 `c7883ec`。
- 包面：**66 文件**、packed 218.1 kB、unpacked 600.1 kB、shasum `88777e722be64ae0f0dcd63108d0e0f434d5a509`、tag `latest`。
- 发布前实测：离线套件 **537/537**（0 跳过）；`gate --all` = `ORCH_GATE: PASS — 5 criteria`（L1 537 pass / 0 fail；L4 三文档对账 537==537）；`release-integrity` rc=0（45 核心 / 60 运行时）；`--tasks smoke` rc=0；真机轮 codex + hermes 双绿（每轮 RUN_RC=0 + verify rc=0；产物内容级核验 `LIVE-07-OK` / `LIVE-08-OK`）。
- registry 回读：`npm view` → `latest = 26.10.14-1`（传播约 2–3 分钟）；tarball 直解包 → 66 文件、shasum 与发布心跳一致 `88777e72…`；`npx -y --prefer-online open-tui-orchestrator@26.10.14-1 --version` → `open-tui-orchestrator 26.10.14-1 (core 0.9.24-1)`；本机全局安装已更新至 `26.10.14-1`。

## 发布记录追加：26.10.18-1（正式版·六宿主双形态 + 动态容量轮，2026-10-18 下午 +08）

- 版本：`open-tui-orchestrator@26.10.18-1`（`--tag latest`）。内容＝六宿主双形态验收（headless 6/6、窗口容量 6/6 理想轮）＋ 动态容量实证（24 个独立块 → 引擎按实时内存自足合并 12 块 → 12 窗 → 24/24 产物、12/12 verified）＋ `ordered` 第二边界治本（重试块以首次 attempt 结束为释放时刻）＋ 起窗节奏默认 5000ms ＋ `--status` 真缺陷修复（每历史窗口一次全表 WMI 快照 → 一次快照复用，26s→5s；只读入口不再做宿主模型/effort 继承）；合并提交 `b844f2d`，发布提交 `9769ba8`；`beta` 与 `master` 同点。
- 包面：**66 文件**、packed 220.1 kB、unpacked 604.9 kB、shasum `2ba8aa9f1ea04aada41e0d18a410e0a1a7499cc6`、tag `latest`。
- 发布前实测：离线套件 **543/543**（0 跳过）；`gate --all` = `ORCH_GATE: PASS — 5 criteria`（L1 543 pass / 0 fail；L4 三文档 543==543）；`release-integrity` rc=0（45 核心 / 60 运行时）；`--tasks smoke` rc=0。
- registry 回读：`npm view` → `latest = 26.10.18-1`（传播约 2 分钟）；`npx -y --cache <fresh> open-tui-orchestrator@26.10.18-1 --version` → `open-tui-orchestrator 26.10.18-1 (core 0.9.24-1)`；本机全局已更新至 `26.10.18-1`；`orch --tasks` 只读零发车、`orch --doctor` `hostError=null`。
- 附记：本轮发布登录票失效（`npm whoami` 401），改用 granular token（Bypass 2FA）完成发布；旧 token 全盘残留扫描仅 1 处（Hermes `interrupted_turns.json`）已清理，复扫 0 命中。

## 发布记录追加：26.10.19-1（自改判定精度修复轮，2026-10-19 上午 +08）

- 版本：`open-tui-orchestrator@26.10.19-1`（`--tag latest`）。内容＝自改判定误拦修复（紧邻窗口判定：自指词与修改词须同一 ≤24 字符窗口内且无否定词；词表补 OTUI/编排逻辑、去裸编排；报告语料不再误拦、OTUI 自改不再漏拦）＋ `--verify-run` JSON 输出 ＋ caller-driven 文档三处（id 位置生成 / profile 级继承 / verify-run stdout）；发布提交 `23b0981`；`beta` 与 `master` 同点。
- 包面：**66 文件**、packed 220.6 kB、unpacked 605.8 kB、shasum `0a1c0e55c622ffe545aaa6c5d3479b83771905c7`、tag `latest`。
- 发布前实测：离线套件 **544/544**（0 跳过，+7 用例）；`gate --all` = `ORCH_GATE: PASS — 5 criteria`（L1 544 pass / 0 fail；L4 三文档 544==544）；`release-integrity` rc=0（45 核心 / 60 运行时）；`--tasks smoke` rc=0；真机双向（审计语料 → single-block inline 退回；自改语料 → self-mod 拦）。
- registry 回读：`latest = 26.10.19-1`；tarball 直解包 → `open-tui-orchestrator 26.10.19-1 (core 0.9.24-1)`、包内 `release-integrity` rc=0（解包副本自洽）；本机全局已升级至 `26.10.19-1`。
- 附记：npm 自 2025-12 起 `npm login` 只发 **2 小时 session token**（官方："expire after two hours"）——本轮首次发布遇 401 即此机制；改用 90 天 granular token（Bypass 2FA）后免反复登录，unpublish 仍需临时删 token 走交互式 2FA。
