# 公开可用性差距清单（2026-09-14）

目标：让**外人**装得上、跑得起来、看得懂。每条都有验证方式；状态只有三种：**已具备** / **待补** / **需你决策**。

## 一、已经具备（都有现场证据）

| 项 | 证据 |
| --- | --- |
| MIT 许可 + 作者署名 | `LICENSE` |
| 离线回归全绿 | 292/292（本轮补 2 条：`scripts/gate.mjs` 自身可红判据；Windows-only 入口拒绝判据——判据本身已用「去守卫 + 重封副本」验证能红；2026-09-15 再补 1 条：封印树「链接拒绝」判据——红例用「摘掉链接检查 + 类型白名单」实测能红） |
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
2. **npm 发布——只差登录**：`npm publish --dry-run` 全绿（**92 文件 / 298 kB**，本轮加 `scripts/gate.mjs`）；`private` 已去、`files` 白名单已验（不加排除会被 385 MB 的 `scripts/node_modules` 卷进去）、元数据齐备。
   **需要你**：`npm login`（或给 token）→ `npm publish`。
3. ~~CI~~ **完成 2026-09-14 / 实测 2026-09-15**：`.github/workflows/ci.yml`（`windows-latest` + Node 24 + 装 codex + `--install-deps` 自检 + `node scripts/gate.mjs --all`）。**实测结论**：在私有仓手动派发该工作流 → 作业零步骤、3 秒失败，GitHub 注解为「recent account payments have failed or your spending limit needs to be increased」——**私有仓的 Actions 作业起不来（与代码无关，是账户计费问题）**；而 GitHub 计费文档明确：**公开仓的标准 hosted runner 免费**。所以正确姿势是**转公开后再武装**（改文件头 2 行 `on:`），提前武装只会收获红叉。
4. ~~公开文档面~~ **完成 2026-09-14**：`CHANGELOG.md`、`.github/ISSUE_TEMPLATE/bug_report.yml`、`SECURITY.md`（私密漏洞报告渠道 + 披露政策）、`CONTRIBUTING.md`（屋规：判据必须能红、封印纪律、数字对账）。
5. ~~信任与安全声明~~ **完成 2026-09-14**：`docs/trust-and-safety.md`（隐藏 agent 以你的凭据运行、Codex 的 `--dangerously-bypass-approvals-and-sandbox`、`--unit-cmd` 属调用方自授权、写哪些文件、无遥测无后台服务、如何卸载），README/README-zh 首屏与 INSTALL 均给出一行摘要 + 链接。
6. ~~平台声明~~ **完成 2026-09-14**：README/README-zh 首屏与 INSTALL「Requirements」均明写 **Windows-only**，其它平台直接给诊断。
7. **外部首次验收——你的部分**：在一台干净的 Windows 机器/用户上走一遍（装 Node → 装包 → `--install-deps` → doctor → 双块真跑）。`docs/release-policy.md` 已把「不同 Windows 用户安装」列为发行门槛。
   **注意（2026-09-15 环境事实）**：本机 codex 账号额度耗尽（Sep 19 恢复）——模型驱动的真跑今天做不了；编排器在该条件下退化正确（inline 明说、无假成功），调用方自助通道（零模型调用）的真机双块验收已于 2026-09-15 通过。
8. ~~验收证据去本地化~~ **完成 2026-09-14**。

### 公开前一毫米（做完这两步就是公开态）
```powershell
# 一、发布（产物已验证：93 文件 / 303 kB、三步安装走通；2026-09-15 重测）
npm login && npm publish

# 二、转公开
gh repo edit yechang1450/open-tui-orchestrator --visibility public --accept-visibility-change-consequences
# 然后按 .github/workflows/ci.yml 头部注释武装 CI（2 行）——转公开同时也解锁免费 CI：
# 私有仓的 Actions 作业被账户计费拦截（2026-09-15 实测），公开仓的标准 runner 免费。
```

## 三、需要你决策

**当前只剩两个决定，且都是「点不点」的问题（其余我已在 2026-09-14 全部收口）：**

- **仓库是否转公开**（private → public）：不可逆；历史里只有作者信息（已清理机器用户名，只剩公开的 GitHub 句柄）。
- **npm 发布账号**：用你的账号、还是开组织 scope（如 `@yechang1450/open-tui-orchestrator`）？决定后只差一次 `npm login`。

已由我按「最省事且不烧钱」定完、不需要你操心的：平台路线（Windows-only 明说，不投跨平台）、CI（入仓但不带 push 触发，转公开时改 2 行武装）、信任声明与安全渠道（`docs/trust-and-safety.md` + `SECURITY.md`）。

## 四、推进记录

1. ~~个人路径清理 + `CHANGELOG.md` / issue 模板~~ ✅ 2026-09-14
2. ~~`npm publish --dry-run` 预演 + 打包瘦身（`files`）~~ ✅ 2026-09-14（89 文件 / 292 kB）
3. ~~CI 骨架 + 门禁入仓~~ ✅ 2026-09-14（`scripts/gate.mjs` + `.github/workflows/ci.yml`，有意不武装）
4. ~~信任/安全声明定稿 + `SECURITY.md` + `CONTRIBUTING.md`~~ ✅ 2026-09-14
5. 干净环境首次验收（第 7 项）——**你的部分**，过了即可对外说「可以用」
