# Kimi Code 适配器

open-tui-orchestrator 支持已安装的 Kimi Code CLI（kimi.exe）。发起方为 Kimi 会话时可完全省略 `--agent`：宿主检测会沿 Windows 祖先进程链找到 kimi.exe 并自动绑定。

## 使用

```powershell
open-tui-orchestrator --agent kimi --doctor
open-tui-orchestrator --run-id my-run --acceptance-file D:/work/temp/acceptance.json --run-windows '项目91：修改页面，运行测试；项目92：修改接口，检查结果'
```

## CLI 与运行协议

- 解析 PATH 上的 kimi.exe / kimi.cmd / kimi 启动入口，并补查 `%USERPROFILE%\.kimi-code\bin\kimi.exe` 原生安装位；`--help` 必须提供 `--prompt` / `--output-format` / `--auto`，版本取 `--version` 的语义化输出。显式路径错误时不回退、不安装。
- 窗口采用 `kimi -p`（print 模式）：按产品契约，非交互模式默认 auto 权限策略处理常规工具调用，静态 deny 规则保持生效；`--prompt` 与 `--auto/--yolo` 互斥，因此不叠加权限旗标。model/thinking 继承发起窗：显式 ORCH_MODEL 优先，否则按 cwd 匹配最新 kimi 会话读其 wire.jsonl 末条 llm.request 的 modelAlias/thinkingEffort（回退 config.toml），model 转 `-m`、effort 经 KIMI_MODEL_THINKING_EFFORT 按进程透传（kimi provider 生效，其它 provider 类型自动回退 config.toml [thinking].effort）；不读取或输出凭据。
- 提示词从文件读出后作为最后一个 argv 元素传入，且并入数组后再做 Windows PowerShell 5.1 原生命令行修正，嵌入引号、中文与多行内容不丢失。
- 窗口把输出 tee 到日志，启动器按【本块唯一标识】token 行写结果文件（首行 JSON + `__EXIT__=N` 尾行）；等待方只解析首行 JSON。kimi `-p` 在回合结束后自行退出，无需扩展机制。
- 规划走 `kimi -p --output-format stream-json`：stdout 每行一个 JSON 对象，取最后一条 `role=assistant` 的 `content`；meta 行与 stderr 进度一律忽略。不支持的沙箱要求明确拒绝（KIMI_SANDBOX_UNSUPPORTED）。
- argv 顺序硬约束：kimi 解析器对旗标值贪心绑定，提示词必须紧跟 `-p`、其余旗标放最后（`kimi -p --output-format stream-json <提示词>` 会报 `unknown command 'stream-json'`；2026-09-09 真机复现并修复，回归测试锁定）。
- 已知限制（2026-09-09 实测）：kimi 规划器冷调用约 295s，远超拆块默认 90s 超时（ORCH_DECOMPOSE_TIMEOUT_MS 可调）。冷请求会因规划超时而回退单块串行 inline（不开窗）；命中拆块缓存则秒级返回。窗口执行路径不受影响（窗口不走规划器）。

## 验证入口

- `node --test test/kimi-adapter.test.mjs test/kimi-runtime.test.mjs`：真实 CLI 解析、argv 形状、PowerShell 启动器引号/中文/多行回环、结果等待。
- 本机实测（2026-09-09，kimi 0.41.0）：从 Kimi 会话无 ORCH_AGENT 发起 `--spawn`，进程链自动识别为 kimi，真窗口创建 `hello-kimi.txt` 并以 `__ORCH_DONE__ spawn-<id>` 收尾，done=true。

真实调用消耗本机 Kimi 配额；其余 agent 的兼容性以各自的验收记录为准。
