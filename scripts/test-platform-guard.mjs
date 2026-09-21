#!/usr/bin/env node
// 非 Windows 平台上的测试前置诊断。
//
// 背景：本产品是 Windows 专用（可见 TUI 载体、进程快照、PowerShell 启动器），测试套件同样
// 依赖这些运行时 —— 在 Linux/macOS 上直接 `npm test` 会有 ~70 条失败，报错都指向
// "Visible TUI runtime currently requires Windows"，翻半天才知道是平台问题。
// 与其让新用户在这堆报错里找原因，不如给一行诊断（与产品"给诊断而不是半可用"的口径一致）。
//
// 放行方式：
//   npm run test:portable              —— 只跑平台无关用例（路径归一化 / 画像参数）
//   ORCH_TEST_ALLOW_NON_WINDOWS=1 npm test —— 强行跑完整套件（预期大量 Windows-only 失败）
if (process.platform === 'win32' || process.env.ORCH_TEST_ALLOW_NON_WINDOWS === '1') {
  process.exit(0);
}

console.error(`
open-tui-orchestrator 是 Windows 专用产品，测试套件也依赖 Windows 运行时
（可见 TUI 载体 / 进程快照 / PowerShell 启动器）。当前平台：${process.platform}

平台无关的用例仍可运行：
  npm run test:portable

确实要跑完整套件（预期出现大量 Windows-only 失败）：
  ORCH_TEST_ALLOW_NON_WINDOWS=1 npm test
`);
process.exit(1);
