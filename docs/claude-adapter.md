# Claude Code 适配器

open-tui-orchestrator 支持已安装的 Claude Code CLI（claude.exe，2.x）。发起方为 Claude Code 会话时可省略 `--agent`：宿主检测会优先识别 `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` 环境标记，其次沿 Windows 祖先进程链匹配 claude.exe 或 `@anthropic-ai\claude-code` 命令行并自动绑定。

## 使用

```powershell
open-tui-orchestrator --agent claude --doctor
open-tui-orchestrator --run-id my-run --acceptance-file D:/work/temp/acceptance.json --run-windows '项目91：修改页面，运行测试；项目92：修改接口，检查结果'
```

## CLI 与运行协议

- 解析 PATH 上的 claude.exe / claude.cmd / claude 启动入口：npm 风格 shim 会按内容解析到 `node_modules\@anthropic-ai\claude-code\bin\claude.exe`；`--help` 必须提供 `--print` / `--dangerously-skip-permissions` / `--model`，版本取 `--version`（`2.x.y (Claude Code)`）的语义化前缀。显式路径错误时不回退、不安装。
- 窗口采用 `claude -p`（print 模式）：编排器已完成授权归一化，`--dangerously-skip-permissions` 跳过逐条权限询问；model/effort 继承发起窗（显式 ORCH_MODEL/ORCH_EFFORT 优先，否则读 `~/.claude/settings.json` 的 model/effort，缺失即不传，绝不猜测）。
- 提示词并入数组后再做 Windows PowerShell 5.1 原生命令行修正，嵌入引号、中文与多行内容不丢失；argv 形状为 `--dangerously-skip-permissions [--model X] [--effort Y] -p <提示词>`。
- 窗口把输出 tee 到日志，启动器按【本块唯一标识】token 行写结果文件（首行 JSON + `__EXIT__=N` 尾行）；等待方只解析首行 JSON。claude `-p` 在回合结束后自行退出，无需扩展机制。stderr 经 ErrorRecord 还原管道以普通文本并入日志。
- 规划走 `claude -p` 的 stdout 终文本（240s 默认超时，`ORCH_DECOMPOSE_TIMEOUT_MS` 显式设置时优先）。不支持的沙箱要求明确拒绝（CLAUDE_SANDBOX_UNSUPPORTED）。

## 验证入口

- `node --test test/claude-adapter.test.mjs test/claude-runtime.test.mjs`：真实 CLI 解析、argv 形状（model 在 `-p` 前、提示词居末）、PowerShell 启动器引号/中文/多行回环、结果等待、规划超时默认值。
- 本机实测（2026-09-10，Claude Code 2.1.267，core 1.8.0）：headless 双块实跑 `success=true`（收据逐键核对通过、零弹窗），window 模式实跑 `success=true`（可见窗 + popup CONFIRMED）。

真实调用消耗本机 Claude 配额；其余 agent 的兼容性以各自的验收记录为准。
