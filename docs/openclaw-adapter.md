# OpenClaw 适配器

open-tui-orchestrator 支持已安装的 OpenClaw CLI（`openclaw`，2026.10.1 起验证）。适配器驱动 OpenClaw 官方的无头单发面 `agent --local`（一次性提示词 → stdout JSON 信封 → 自行退出），与 kimi/claude 同属 print 类：无 TUI 窗口、无 node-pty、由启动器契约统一负责关闭。

发起方为 OpenClaw 会话时可省略 `--agent`：宿主检测先匹配进程链（`openclaw.cmd` / `openclaw.mjs`），再按 Windows 祖先进程链就近命中自动绑定。

## 使用

```powershell
open-tui-orchestrator --agent openclaw --doctor
open-tui-orchestrator --run-id my-run --acceptance-file D:/work/temp/acceptance.json --run-windows '项目07：修改页面，运行测试；项目08：修改接口，检查结果'
```

## CLI 与运行协议

- 解析 PATH 上的 openclaw / openclaw.cmd / openclaw.exe 启动入口：npm 风格 shim 按内容解析到 `node_modules\openclaw\openclaw.mjs`，并以接口探针 `agent --help` 实测 `--local` / `--message` / `--message-file` / `--json` 旗标与包身份（`package.json` 的 name=openclaw）——探针不符或身份不符一律 fail-closed，绝不回退、不安装。
- 规划走 `openclaw agent --local --json -m <提示词>` 的 stdout JSON 信封（`{ok:true,result.terminalReply.text}`；`ok:false` 报 `OPENCLAW_PLANNER_ERROR`，非 JSON 报 `OPENCLAW_PLANNER_UNPARSEABLE`）。model 经 `--model` 显式传递（含 `/` 的 provider/model 形态；裸词不传，由 CLI 自身配置兜底）。
- 单元执行由 PowerShell 启动器承载：每单元独立 `OPENCLAW_STATE_DIR`（隔离并发单元的运行时状态），`OPENCLAW_CONFIG_PATH` 指向真实用户配置（凭据仍在原位）；提示词经 `--message-file` 传入（多行/中文/引号无损），stdout/stderr tee 到日志。
- 结果契约与其余宿主同构：启动器按【本块唯一标识】token 写结果文件（首行 JSON + `__EXIT__=N` 尾行），等待方核对 result 携带的完成 token 与本单元一致才认（不一致一律 fail-closed：`OpenClaw foreign result rejected`）；重放同 stem 时先清 stale result/pid。
- 不支持的沙箱要求明确拒绝（`OPENCLAW_SANDBOX_UNSUPPORTED`）。版本常量 `OPENCLAW_LAST_VERIFIED = '2026.10.1'` 只记「最后验证于」，不是准入门槛——准入由接口探针实测决定。

## 验证入口

- `node --test test/openclaw-adapter.test.mjs test/openclaw-runtime.test.mjs`：shim→entry 解析、接口探针 fail-closed、包身份校验、argv 形状、JSON 信封解析（成功/错误/非 JSON）、启动器清场与 token 契约、外来 result 拒绝。
- 本机实测（2026-10-12，OpenClaw 2026.10.1，core 0.9.24-1，beta 分支）：七宿主真机轮含 openclaw 端到端（详见 docs/release-policy.md 当轮记录）。

真实调用消耗本机 OpenClaw 配额；其余 agent 的兼容性以各自的验收记录为准。
