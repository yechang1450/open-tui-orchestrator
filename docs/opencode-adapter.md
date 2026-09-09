# opencode 适配器

open-tui-orchestrator 支持已安装的 opencode CLI（npm 包 opencode-ai 的原生 opencode.exe）。解析 npm 启动脚本后直指打包的 `node_modules/opencode-ai/bin/opencode.exe`，不经过批处理拼接。

## 使用

```powershell
open-tui-orchestrator --agent opencode --doctor
open-tui-orchestrator --run-id my-run --acceptance-file D:/work/temp/acceptance.json --run-windows '项目91：修改页面，运行测试；项目92：修改接口，检查结果'
```

## CLI 与运行协议

- 探测要求 `--help` 含 "run opencode with a message" 且 `run --help` 同时提供 `--interactive` / `--auto` / `--dir`；版本取 `--version` 首段。显式路径错误时不回退、不安装。
- 窗口 argv 为 `run -i --auto --dir <工作区>`：`-i` 让 opencode 在本回合结束后自行退出，`--auto` 等价于 pi 的 `--approve`（编排器已完成授权归一）。提示词从文件读出、并入数组后再做 Windows PowerShell 5.1 原生命令行修正，引号、中文与多行内容不丢失。
- 窗口输出 tee 到日志，启动器按【本块唯一标识】token 行写结果文件（首行 JSON + `__EXIT__=N` 尾行）；等待方只解析首行 JSON。诊断走 stderr，启动器经 ErrorRecord 还原管道以普通文本并入日志，窗内不刷红色 NativeCommandError 块（与 kimi 窗同款修复，2026-09-09）。
- 规划走 `run --format json` 的 headless 事件流，取最后一条 assistant 文本事件；`type=error` 事件即拒绝该次规划。
- model 继承发起窗：显式 ORCH_MODEL 优先，否则读 opencode.json(c) 顶层 `model` 转为 `--model`；opencode 无 thinking effort 旗标，不传递；不支持的沙箱要求明确拒绝（OPENCODE_SANDBOX_UNSUPPORTED）。

## 验证入口

- `node --test test/opencode-adapter.test.mjs test/opencode-runtime.test.mjs`：真实 CLI 解析、窗口/规划 argv（含 `--` 后提示词与 `--model` 透传）、PowerShell 启动器回环、stderr 还原、结果等待（含 `__EXIT__=` 尾行兼容与启动器死亡无结果路径）。
- 本机实测（2026-09-09，opencode 1.18.30）：headless 规划探针返回 OK；`--agent opencode --spawn` 真窗口创建 `hello-opencode.txt` 并以 `__ORCH_DONE__ spawn-<id>` 收尾，done=true。

修复记录（相对 2026-09-08 未提交初版）：Write-Result 的 JSON 行冒号位置导致的 PowerShell 解析错误；提示词引号在 PS 5.1 原生命令行边界被吞；结果等待误把 `__EXIT__=` 尾行一起 JSON.parse 导致永远走超时/误报路径。三处均由新增离线测试先行复现再修复。
