# 公开可用性差距清单（2026-09-14）

目标：让**外人**装得上、跑得起来、看得懂。每条都有验证方式；状态只有三种：**已具备** / **待补** / **需你决策**。

## 一、已经具备（都有现场证据）

| 项 | 证据 |
| --- | --- |
| MIT 许可 + 作者署名 | `LICENSE` |
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

1. ~~公开前的个人路径清理~~ **完成 2026-09-14**：18 个 tracked 文件、77 处用户名归一化为 `<user>`；根因一并修掉（证据采集器、画像适配器、hermes 画像 provenance）。验证：`git grep -c <user>` 只剩公开的 GitHub 句柄 `yechang1450`。
2. ~~**npm 发布**~~ **已发布（最新＝0.9.9 · `latest` · 2026-09-17 00:27 +08）**：`open-tui-orchestrator@0.9.9` 已在 registry 上（93 文件 / 315.8 kB、shasum `4dc01c89…`、integrity `sha512-ceuO3vJb…`）。发布前对当轮 HEAD `f1ce647` 复绿：`node scripts/gate.mjs --all` = `ORCH_GATE: PASS — 5 criteria`（295/295）＋ `npm publish --dry-run` 面检同值。账号＝个人账号 unscoped（`npm whoami` = `yechang1450`；正名未被占）。**端到端烟测（0.9.9 · 冷前缀 `D:/temp/orch-coldinstall-099`）**：① `npm install open-tui-orchestrator` → `--version` = `0.9.9 (core 1.14.9)` → `--install-deps` = `{"ok":true,"action":"installed"}`（幂等复跑 `already-present`）→ `--agent codex --doctor` = `hostError=null / carrierAvailable=true`；② `npx --yes open-tui-orchestrator@latest --version` = `0.9.9 (core 1.14.9)`（任何 agent 从 PATH 即装的路径成立）。**历史**：0.9.6 = 2026-09-15 首发（93 文件 / 310.5 kB、shasum `4b16de76…`）。
3. ~~CI~~ **弃用（用户令 2026-09-15）**：GitHub Actions 一律不用——私有仓被账户计费拦死（2026-09-15 实测：作业零步骤、3 秒失败），转公开也不再启用。**判定全部走本机等价门禁**：`node scripts/gate.mjs --all`（一条命令五判据 + 反例能红）＋ 定时巡逻（83 的 schtasks 法，需要时并入）。`.github/workflows/ci.yml` 仅作历史记录保留、不带任何触发。
4. ~~公开文档面~~ **完成 2026-09-14**：`CHANGELOG.md`、`.github/ISSUE_TEMPLATE/bug_report.yml`、`SECURITY.md`（私密漏洞报告渠道 + 披露政策）、`CONTRIBUTING.md`（屋规：判据必须能红、封印纪律、数字对账）。
5. ~~信任与安全声明~~ **完成 2026-09-14**：`docs/trust-and-safety.md`（隐藏 agent 以你的凭据运行、Codex 的 `--dangerously-bypass-approvals-and-sandbox`、`--unit-cmd` 属调用方自授权、写哪些文件、无遥测无后台服务、如何卸载），README/README-zh 首屏与 INSTALL 均给出一行摘要 + 链接。
6. ~~平台声明~~ **完成 2026-09-14**：README/README-zh 首屏与 INSTALL「Requirements」均明写 **Windows-only**，其它平台直接给诊断。
7. **外部首次验收——你的部分**：在一台干净的 Windows 机器/用户上走一遍（装 Node → 装包 → `--install-deps` → doctor → 双块真跑）。`docs/release-policy.md` 已把「不同 Windows 用户安装」列为发行门槛。
   **注意（2026-09-15 环境事实）**：本机 codex 账号额度耗尽（Sep 19 恢复）——模型驱动的真跑今天做不了；编排器在该条件下退化正确（inline 明说、无假成功），调用方自助通道（零模型调用）的真机双块验收已于 2026-09-15 通过。
8. ~~验收证据去本地化~~ **完成 2026-09-14**。

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
