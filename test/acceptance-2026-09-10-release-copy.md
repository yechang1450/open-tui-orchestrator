# RC 验收项 C：open-tui-orchestrator 发行副本 安装/升级/回滚 验收证据

- 日期：2026-09-10（Windows + Git Bash，node v24.21.0）
- 被验仓库（全程只读）：`C:\Users\<user>\.tools\open-tui-orchestrator`（另一场 live 验收实跑中）
- 产物目录：`D:\temp\orch-acceptance-C\`（原始输出见同目录 `transcript.txt`）
- 基线：仓库封印 schema 2、coreVersion 1.7.0、31 核心文件 + 49 运行时文件，与发行政策一致
- 政策背景：本仓库是独立私有 CLI（`"private": true`，无插件管理器清单），发行政策第 5 步中「插件管理器激活升级回滚」落地为 repair.mjs 产出发行副本后的**目录级安装/升级/回滚**

## 总结论

| 验收项 | 结论 | 说明 |
|---|---|---|
| 安装（repair.mjs 产出发行副本） | **PASS** | 一次生成 118 文件干净副本，自带封印复验通过 |
| 升级（副本目录级替换 + 副本内重封印） | **PASS** | 封印工具原生支持对副本目录操作（正面路径成立），另附篡改检测负面证据 |
| 回滚（换回旧副本） | **PASS** | 版本痕迹回到 1.7.0，封印复验通过，功能冒烟正常 |

## 关键机制（以实际代码为准）

- `repair.mjs --target <绝对路径>`：发布到 `<target>/open-tui-orchestrator`；目标已存在或在源码树内即拒绝；发布前强制 `verifyRelease(源码)` 与必需文件检查；staging + rename 原子落位，失败自动清理（`repair.mjs:167-218`）。
- 副本内容：排除 `.git/temp/coverage/node_modules` 与运行碎屑（`PROTECTED_DIRS`/碎屑规则），保留 `scripts/docs/test`、README、LICENSE、release.json。
- 封印工具 `scripts/release-integrity.mjs`：root 由**脚本自身位置**推导（`path.resolve(dirname(fileURLToPath(import.meta.url)), '..')`，第 6 行），因此**副本自带的校验/重封印天然作用于副本目录，无支持缺口**；`verifyRelease(packageRoot)` 也显式接受根目录参数。
- 封印绑定：`scripts/core/contracts.mjs` 的 `CORE_VERSION`（→ release.json 的 coreVersion）+ 核心/运行时文件 SHA-256 清单；`package.json` 在运行时清单内（改它即破封印）；release.json 自身、docs/、test/、node_modules/ 不入清单。
- 维护锁：publish 期间在 `~/.open-tui-orchestrator/maintenance-lock.json`（仓库外）短暂礼让性上锁，各退出点显式释放；本验收前后均确认无遗留锁。

## 步骤与证据

### 1. 安装 — PASS

命令：`node C:/Users/<user>/.tools/open-tui-orchestrator/repair.mjs --target D:/temp/orch-acceptance-C/v1`
输出：`published 118 file(s) to D:\temp\orch-acceptance-C\v1\open-tui-orchestrator`，exit=0。发布后维护锁已释放；副本顶层无 .git/temp/coverage。

### 2. 副本复验 — PASS（含两点发现）

- 副本自带封印校验：`node v1/open-tui-orchestrator/scripts/release-integrity.mjs` → `{"schema":2,"coreVersion":"1.7.0","files":31,"runtimeFiles":49}`，exit=0。
- 副本 `repair.mjs` 只读自检：封印 OK + 5 个必需文件 OK + 无运行碎屑，`RESULT: publishable`，exit=0。
- 版本核对：副本 `package.json` version=**0.3.0**，`contracts.mjs` CORE_VERSION=**1.7.0**。**发现①：CLI 无 `--version` 子命令**（未知参数落到引擎 Usage，exit=0）；版本痕迹载体是 package.json version 与 CORE_VERSION 两套号，封印只绑后者。
- 只读冒烟：`--help` 正常（exit=0）；`--agent kimi --doctor` 输出完整 JSON（agent=kimi、解析到 kimi.exe、terminal=wt、workspace/stateDir 均指向验收目录），exit=0；`--status --readonly` 正常，exit=0；冒烟全程零状态写入。
- **发现②：codex 路径有两道只读门禁**（设计行为，非副本缺陷）：副本不含 node_modules → codex doctor 先报 `RELEASE_DEPENDENCY_MISSING`（指引 `npm ci --prefix scripts`，即 package.json 的 setup 脚本）；按指引在副本内安装（3 包，6s）后报 `CLI_MISSING: codex`（本机无 codex 可执行文件，政策明确「不自动安装、不回退」）。安装依赖后封印仍 31+49 通过（node_modules 不入封印清单）。

### 3. 升级模拟 — PASS

- 生成 v2：`repair.mjs --target D:/temp/orch-acceptance-C/v2` → 118 文件，exit=0。
- 在 **v2 副本内**制造新版本痕迹：package.json version `0.3.0→1.7.1-rc1`，contracts.mjs CORE_VERSION `1.7.0→1.7.1-rc1`。
- **负面测试（额外证据）**：篡改后未重封印时 `release-integrity.mjs` 报 `RELEASE_INTEGRITY_FAILED: core differs from the verified release`，exit=1 —— 封印校验确实能发现副本被篡改。
- **副本内重封印（正面路径）**：`node v2/open-tui-orchestrator/scripts/release-integrity.mjs --seal` → 重写副本 release.json，复验 `{"schema":2,"coreVersion":"1.7.1-rc1","files":31,"runtimeFiles":49}`，exit=0；副本 `repair.mjs` 自检 core=1.7.1-rc1 通过。
- 安装位替换：`mv v1 installed`（基线 1.7.0）→ `mv installed installed-old && mv v2 installed`。安装位复验：coreVersion=1.7.1-rc1、package.json=1.7.1-rc1、封印通过；`--agent kimi --doctor` 功能冒烟正常。

### 4. 回滚 — PASS

- `mv installed installed-rc1（留存证据）&& mv installed-old installed`。
- 安装位复验：`{"schema":2,"coreVersion":"1.7.0",...}`，package.json 回到 0.3.0、CORE_VERSION 回到 1.7.0；`repair.mjs` 自检通过；`--agent kimi --doctor` 与 `--status --readonly` 冒烟正常。

### 5. 合规性核查

- 仓库零改动：`git -C <仓库> status --porcelain` 无输出（干净），仓库封印复验仍 1.7.0/31+49。未跑仓库测试套件、未在仓库内新建/删除文件（publish 的维护锁在仓库外且已释放）。
- 全程未执行 `--run-windows/--run/--spawn/--resume-run`，未开任何 agent 窗口；仅 help/doctor/status/封印校验等只读命令。
- 一切产物均在 `D:\temp\orch-acceptance-C\` 内；未动 `D:\` 根 git；未写 memory。

## 发现的问题 / 缺口清单

1. **CLI 缺 `--version`**：`cli.mjs` 与引擎均无版本输出子命令，版本核对只能看 `package.json`（0.3.0）与 `contracts.mjs` CORE_VERSION（1.7.0）。两套号并存，发行政策以 coreVersion 为准；建议后续发行补一个只读 `--version`（或把 package.json version 与 coreVersion 对齐），否则「核对版本一致」这一步对安装者没有现成抓手。
2. **无缺口：封印工具支持副本目录**。`release-integrity.mjs` 的 root 按脚本位置推导，副本自带校验与 `--seal` 重封印均作用于副本本身；任务预案中的「不支持则退负面测试」未触发，正面路径成立，且负面测试（篡改必被发现）也额外取到证据。
3. **codex 路径依赖安装后步骤**：发行副本按设计不含 node_modules 与宿主 CLI；codex agent 需先 `npm ci --prefix scripts` 且宿主装有 codex CLI，否则依次得到 `RELEASE_DEPENDENCY_MISSING` / `CLI_MISSING: codex` 诊断（只读、带修复指引、不自动安装）。kimi 路径无此门禁。验收文档/安装器应把 `npm run setup` 列为 codex 安装位的必需步骤。
4. **维护锁影响面**：publish 会在用户目录短暂上维护锁（秒级），对并发 live 实跑为礼让性门禁；本次实跑未受可观测影响，但并发窗口期理论上动作入口会收到一次固定话术。

## 产物清单（D:\temp\orch-acceptance-C\）

- `installed/open-tui-orchestrator` —— 当前安装位（回滚后 = 1.7.0 副本，含按政策补装的 scripts/node_modules）
- `installed-rc1/open-tui-orchestrator` —— 1.7.1-rc1 升级副本（留存证据，已重封印）
- `runtime-work/` —— 冒烟命令的工作目录（零状态写入）
- `transcript.txt` —— 全程命令+原始输出
- `evidence.md` —— 本文件
