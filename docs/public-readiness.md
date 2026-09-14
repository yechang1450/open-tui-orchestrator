# 公开可用性差距清单（2026-09-14）

目标：让**外人**装得上、跑得起来、看得懂。每条都有验证方式；状态只有三种：**已具备** / **待补** / **需你决策**。

## 一、已经具备（都有现场证据）

| 项 | 证据 |
| --- | --- |
| MIT 许可 + 作者署名 | `LICENSE` |
| 离线回归全绿 | 283/283 → 本轮加 3 条后 286/286（`test/install-deps.test.mjs`） |
| 发行封印 + 副本流程 | `release.json`（43 核心 + 62 运行时）、`repair.mjs`、`docs/release-policy.md` |
| 机器可调用失败契约 | 一行 `[orchestrator] FATAL: …`、退出码 0/1/2、未知 run 不挂起（1.13.0 起） |
| 安全审计（当前核心） | `docs/security-audit-2026-09-09.md`（无 Critical/High；Medium/Low 已修或登记） |
| 一键补依赖 | **本轮新增** `--install-deps`：幂等、失败干净、stdout 纯数据、从不碰 agent CLI |
| 安装路径实测 | `npm pack`（403 kB / 162 文件）→ 装进独立前缀 → `--install-deps`（3 s，npm 缓存）→ `--doctor` `hostError=null` `carrierAvailable=true` |
| 安装文档 | **本轮新增** `INSTALL.md` / `INSTALL-zh.md` + README 安装节 |
| 调用方接入 | `docs/caller-driven.md`（任何 agent 四行接入、`--plan-file`、`--unit-cmd`、`--tasks`） |

## 二、待补（按我的排序；1–3 是硬门槛）

1. **公开前的个人路径清理**——16 个 tracked 文件带机器路径（`test/acceptance-*.json`、`docs/`；核心件 `scripts/core/agent-profiles/hermes.json` 里 `adaptedFrom.cli` 是机器绝对路径，属 provenance，功能无关但会暴露用户名）。
   验证：`git grep -l <user>` 清零或只剩有意保留的历史证据。
2. **npm 发布**——包名 `open-tui-orchestrator` 未被占用（已查：registry 404）。要动的东西：去掉 `private: true`、加 `files` 字段把 `test/` 排除出包、决定是否带 `repository`/`homepage`/`keywords`。
   需要你：npm 账号与 token（或你来跑 `npm publish`）。发布前预演：`npm publish --dry-run`。
3. **CI（GitHub Actions, `windows-latest`）**——跑离线套件（前置 `npm i -g @openai/codex`，套件的环境约定会自解释）+ 机器门禁入仓（现在门禁在 `D:\build\tools\orch-level-check.py`，对公开仓库不存在）。
   验证：CI 上 `ℹ pass 286 / ℹ fail 0`，并把门禁的 L1/L2a/L2b/L3/L4 做成可跑的 job。
4. **公开文档面**——`CHANGELOG.md`（用户视角的变更）、`SECURITY.md`（漏洞报告渠道 + 披露政策）、`CONTRIBUTING.md`、issue 模板、supported-hosts 矩阵（哪个 CLI 哪一版验证过）。
5. **信任与安全声明**——把「默认 headless 隐藏窗 / Codex 带 `--dangerously-bypass-approvals-and-sandbox` / `--unit-cmd` 是调用方自授权 / 只写 `<workspace>\temp\orchestrator` / 无后台服务」写成公开可见的一节（INSTALL 已有简版，建议独立章节 + SECURITY.md 交叉引用）。
6. **平台声明**——当前 Windows-only（代码有硬门 + PowerShell 启动器 + ConPTY）。公开首页要写清；是否做 Linux/macOS 需要你定方向（我的评估：属大工程，建议先不做，明说即可）。
7. **外部首次验收**——在一台**干净的 Windows 用户/机器**上走一遍：装 Node → 装包 → `--install-deps` → doctor → 一个双块真跑 → 看板与 `summary.json`。`docs/release-policy.md` 已把「不同 Windows 用户安装」列为发行门槛。
8. **验收证据去本地化**——`test/acceptance-*.json` 里的 `D:/temp/...`、`C:\Users\...` 绝对路径改成相对/可复现写法，否则对公开读者无意义（可与第 1 项一起做）。

## 三、需要你决策

- **仓库是否转公开**（private → public）：影响面最大、不可逆（历史里已有作者信息，属正常）。
- **npm 发布账号**：用你的账号，还是开组织 scope（如 `@yechang1450/open-tui-orchestrator`）？
- **平台路线**：Windows-only 明说，还是要投入做跨平台？（我建议：先明说，不投。）
- **要不要 CI**：公开后 CI 分钟数在私有仓要计费；Windows runner 尤其贵。可以先只在 push 到 tag 时跑。

## 四、我的推进顺序（建议）

1. 个人路径清理 + `CHANGELOG.md` / issue 模板（**今天就能做完、零风险**）
2. `npm publish --dry-run` 预演 + 打包瘦身（`files` 字段），拿到你的 npm 账号后真发
3. CI 骨架（先私有仓跑通，再随转公开）
4. 信任/安全声明定稿（结合 SECURITY.md）
5. 干净环境首次验收（第 7 项），过了再对外说「可以用」
