# 自动适配（print-class 画像管线）

open-tui-orchestrator 对"一次性提示词 → stdout 终文本 → 自行退出"形态的 agent CLI（如 kimi/claude/  aider）
提供数据驱动的通用适配：**一份 JSON 画像**即可接入，不必手写专用适配器。

## 命令

```
node scripts/adapt.mjs [--agent <id>] [--cli <path>] [--profiles-dir <dir>]
                       [--no-live] [--no-commit] [--suite] [--smoke] [--force] [--json]
```

流程（任何一步失败都**回滚画像**，仓库保持原状）：

1. **定位**：`--agent`（缺省用调用方探测结果）→ `--cli`/`ORCH_CLI` → PATH 上的 `<id>.exe`。
   `.cmd`/shell shim 无法被直接 spawn（Windows 限制），会自动拒绝并提示指向真实可执行文件；
   `.mjs`/`.cjs` 形态自动以 node + 脚本运行。
2. **表面探测**：`--version` 取语义化版本；`--help` 里找一次性提示词旗标（候选
   `-p/--print/--message/-m`）、自动批准旗标（候选 `--yes-always/--dangerously-skip-permissions/
   --yolo/--auto/--approve/--full-auto/--dangerously-bypass-approvals-and-sandbox`）、`--model`、`--effort`。
3. **生成画像**：`scripts/core/agent-profiles/<id>.json`（schema 见文件头注释；含 adaptedFrom 审计字段）。
4. **解析自检**：用画像走一遍 `resolveProfileHost`，版本必须与探测一致。
5. **活体验证（默认开）**：真实调用一次该 CLI，要求它只回一个随机探活令牌
   （`ADAPTOK-xxxxxxxx`）；未回、超时或非零退出即失败回滚。`--no-live` 关闭（不推荐）。
6. **块级真实验收（可选 `--smoke`）**：用画像 agent 走一遍真实的 `orch` 单块执行
   （checkpoint 协议 + 验收契约 + 结果文件），把"能接上"验证到"跑得通"。
   ⚠️ 会消耗该 agent 的真实额度，且要求它已登录/有模型配置。
7. **重封 + 自动提交（默认开）**：`release-integrity --seal` 后，仅提交画像文件与 `release.json`
   （显式路径，绝不用 `git add -A`）。`--no-commit` 关闭。

## 对新 agent 的完整度对照（拿"完整功能"逐项核对）

| 能力 | 画像 agent 是否自动具备 |
|---|---|
| 双模式派发（headless 默认 / `--mode window`） | ✅ 引擎层，与 agent 无关 |
| 执行看板（`[board]`/events.jsonl/`--watch`/`--status`） | ✅ 引擎层 |
| 全局租约/波次/容量/准入/错峰、恢复/守护/`--resume-run` | ✅ 引擎层（启动器契约同构） |
| `orch` 强制入口、维护锁、验收契约、checkpoint 协议 | ✅ 引擎层 |
| CLI 解析 / argv（批准/模型/提示词旗标）/ 启动器 / 等待 / 规划器 | ✅ 画像路径全量覆盖 |
| 宿主识别（谁调用我） | ✅ 进程名自动（`^<id>(\.exe)?$`）；⚠️ env 标记自动探测为空，可手填 `envMarkers` |
| **model/effort 跟随发起窗** | ❌ **缺口**：画像 agent 暂无"读发起窗当前模型"的探测器→单元用该 CLI 自身默认；用 `ORCH_MODEL/ORCH_EFFORT` 显式补齐，或后续为该 CLI 手写探测器（参考 host-model.mjs） |
| 活体验收深度 | 默认=令牌探活；`--smoke` = 块级真实执行验收 |
| 纯交互 TUI（无一次性提示词旗标） | ❌ 硬边界：明确拒绝，需手写专用适配器 |

结论：**print-class 的 agent 经自动适配后继承引擎的全部横切功能与适配器全链路**；
已知差异只有 model/effort 的自动继承（可显式补齐）与非 print-class 的手写边界。
`ORCH_AUTO_ADAPT=1` 自动模式只做"令牌探活"级验证（不跑 `--smoke`，避免未经同意消耗额度）。

## 自动模式（环境检测即适配）

```
ORCH_AUTO_ADAPT=1 node <cli> --agent <未适配的 id> --run-windows "<请求>"
```

薄壳 wrapper 在加载引擎**之前**检查：检测到未适配 agent 且仓库未上锁 → 直接跑完整适配管线
（表面+活验+重封+提交）→ 成功则继续本轮调用；失败则 **fail-closed** 报
`AUTO_ADAPT_FAILED`（不静默降级）。维护锁持有期间跳过适配，由引擎照常返回维护话术。

## 安全护栏

- **维护锁**：锁持有期间拒绝写入（`--force` 例外）；适配自身的写入/重封/提交窗口内也会短暂持锁。
- **失败回滚**：画像写入后任何一步失败都会恢复原状（含旧画像的备份还原）。
- **可审计**：画像携带 `adaptedAt/adaptedFrom{cli,version,prefixArgs}`；提交信息标注
  `[auto-generated]`。
- **不改核心**：适配产物只有画像 JSON 一笔；引擎代码零改动（除非该 CLI 不属于 print-class）。

## 适配成功的判定

表面探测 + 解析自检 + 活体验证三步全过即"适配成功"并自动提交。**块级真实执行的验收仍建议人工复测**
（用 `orch` 起一两轮真实任务确认），这也是设计上的分工：自动管线保证"能接上"，人工复测保证"跑得好"。

## 实弹记录（2026-09-11）

- **假 CLI（离线全链）**：`test/print-profile.test.mjs` 六条全绿——探测生成、解析/argv、PowerShell
  启动器回环（checkpoint 协议）、结果等待、`orch` 端到端 success、内置 agent 跳过。
- **真 CLI：aider 0.86.2**（本机安装、未被适配过）：
  - 表面探测 ✓（`--version`=0.86.2；`--message`/`--yes-always`/`--model` 词边界匹配）；
  - 画像生成 ✓ + 解析自检 ✓；
  - **活体验证两次实操抓到真问题**：①首轮把 `--auto-commits` 子串误配成 `--auto`，aider 报
    `ambiguous option`——活验守门当场拒绝并回滚（零提交）；修复为词边界匹配后 ②aider 因**未配置
    登录**弹出 OpenRouter OAuth 等待人工授权——活验按时超时、回滚、零提交（符合"未授权 CLI
    fail-closed"的边界设计）。该机无 aider 配置也无任何 API key 环境变量，登录完成后重跑
    `node scripts/adapt.mjs --agent aider` 即可自动完成最后一跳（活验→重封→提交）。

## 边界（明确不支持）

- **纯交互 TUI 且无一次性提示词旗标的 CLI**：探测会明确报告 `not a print-class CLI`，需要手写专用适配器
  （参考 kimi/claude 适配器的形态）。
- 需要**交互式登录/设备码授权**的 CLI：活体验证会因未授权失败（fail-closed），请先在该 CLI 里完成登录。
- 沙箱/审批语义：画像类 agent 只支持 `danger-full-access`（编排器已归一化授权），要求受限沙箱会被明确拒绝。

## 验证入口

```
node --test test/print-profile.test.mjs
```

覆盖：假 print-class CLI 的表面探测与画像生成、解析与 argv 形状、启动器 PowerShell 回环
（引号/中文/checkpoint 协议/结果文件）、结果等待、`orch` 端到端（画像 agent 强制派发 + 验收 verified）、
内置 agent 跳过。活体记录见 `docs/` 提交历史与本文件更新。
