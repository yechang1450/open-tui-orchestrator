// Failure policy (user directive 2026-09-18): every failure walks three tiers —
//   1. tier 'auto'     : the engine already repairs it on its own (retry, reclaim, re-pop).
//   2. tier 'repair'   : known remedy exists; the engine attempts it and records the outcome.
//   3. tier 'guidance' : nothing left to try; the report must state problem + cause + what was
//                        already tried + exactly what the user should do next (never a bare error).
// Pure and side-effect free so both the CLI surface and the run ledger can reuse it.

const RULES = [
  { match: /^CLI_MISSING:\s*([\w-]+)/i, build: (m) => ({
    tier: 'guidance', title: `宿主 CLI 未找到：${m[1]}`,
    cause: `PATH 与 --cli 候选中没有可用的 ${m[1]} CLI（已逐一探测 --help/--version）。`,
    tried: ['枚举 PATH 候选（.exe/.cmd/npm shim）', '逐个执行 --help / --version 探针', '检查 ORCH_CLI 指定路径'],
    fix: `安装该 CLI（例如 npm i -g <包名>）后重跑；或显式指定可执行文件：--cli <完整路径>（或设 ORCH_CLI）。`,
    docs: 'docs/host-adapters.md',
    autoRepairs: ['枚举全部候选与 shim', '尊重 ORCH_CLI/--cli 显式指定'],
  }) },
  { match: /^HOST_UNKNOWN/i, build: () => ({
    tier: 'guidance', title: '无法判定宿主 agent',
    cause: '既没有 --agent/ORCH_AGENT，也没有可识别的宿主环境标记。',
    tried: ['环境标记探测', '进程链推断'],
    fix: '显式指定：--agent <pi|claude|kimi|opencode|codex|hermes|openclaw>；或自带单元命令 --unit-cmd/--unit-cmd-file 绕过宿主识别。',
    docs: 'docs/caller-driven.md',
    autoRepairs: ['环境标记与进程链双路推断'],
  }) },
  { match: /^ADAPTER_UNSUPPORTED:\s*([\w-]+)/i, build: (m) => ({
    tier: 'guidance', title: `该宿主没有适配器：${m[1]}`,
    cause: '内置适配器未覆盖此宿主，且设计上不做隐式回退。',
    tried: ['适配器表查询'],
    fix: '两条支持路径：① 自带单元命令 --unit-cmd/--unit-cmd-file（任意 CLI 通用）；② 跑 print 类自动适配：node scripts/adapt.mjs --agent ' + m[1],
    docs: 'docs/caller-driven.md',
    autoRepairs: [],
  }) },
  { match: /usage limit|You've hit your usage limit/i, build: () => ({
    tier: 'guidance', title: '账号额度耗尽',
    cause: '宿主账号（ChatGPT/套餐）的用量配额已用尽，服务端拒绝执行。',
    tried: ['读取服务端返回的恢复时间', 'WebSocket→HTTPS 传输回退'],
    fix: '等待额度重置（服务端会给出时间，形如 "try again at Sep 19th …"），或升级套餐；重置后重跑同一命令即可（幂等，无需清理）。',
    docs: 'docs/host-adapters.md',
    autoRepairs: ['传输层回退（WebSocket→HTTPS）'],
  }) },
  { match: /not supported when using Codex with a ChatGPT account/i, build: () => ({
    tier: 'guidance', title: '该模型在 ChatGPT 账号下不可用',
    cause: '指定的 model id 不支持 ChatGPT 登录（需要 API-key 登录），或不在账号的模型目录内。',
    tried: ['读取本机 models_cache.json 的合法模型与档位'],
    fix: '换用账号支持的模型（见本机 ~/.codex/models_cache.json），或改用 API-key 登录后再用该模型。',
    docs: 'docs/host-adapters.md',
    autoRepairs: [],
  }) },
  { match: /disk too low|ENOSPC/i, build: () => ({
    tier: 'guidance', title: '工作区磁盘空间不足',
    cause: '可用空间低于硬底线，为避免写坏账本选择拒跑（fail-closed）。',
    tried: ['目标盘空间探测'],
    fix: '清理工作区所在盘的空间（或换工作区：--workspace <其它盘路径>），然后重跑。',
    docs: 'docs/execution-contract.md',
    autoRepairs: [],
  }) },
  { match: /spawn .* ENOENT|ENOENT/i, build: () => ({
    tier: 'repair', title: '启动子进程失败（路径不存在）',
    cause: '传给原生程序的可执行文件或工作区路径在当前平台不存在（常见于 MSYS 风格路径 /d/… 未转换）。',
    tried: ['重试一次', '路径原生化检查'],
    fix: '确认 --cli/--workspace 使用原生路径（如 D:/dir，而不是 /d/dir）；确认该可执行文件确实存在。',
    docs: 'docs/execution-contract.md',
    autoRepairs: ['单次重试', '工作区路径存在性预检'],
  }) },
  { match: /EPERM|EACCES|access is denied|拒绝访问/i, build: () => ({
    tier: 'repair', title: '权限被拒绝',
    cause: '文件/进程操作被系统拒绝（占用、只读、杀软拦截或权限不足）。',
    tried: ['解锁重试', '回收过期锁票'],
    fix: '确认目标文件未被别的程序占用；必要时以更高权限运行或把工作区换到用户可写目录。',
    docs: 'docs/execution-contract.md',
    autoRepairs: ['回收过期锁票/租约后重试'],
  }) },
  { match: /Uncertain tasks|needs-reconciliation/i, build: () => ({
    tier: 'repair', title: '单元结果无法确证（防假绿而拒收）',
    cause: '单元中途终止，既没有通过验收，也没有声明「重跑安全」，引擎按诚实原则拒绝把它记成成功。',
    tried: ['独立复验（内容/命令双查）', '已通过验收的任务不复做'],
    fix: '若该任务本身是幂等可重跑的（例如只写文件），在验收文件里为它声明 {"checks":[…],"retrySafe":true}，引擎就会自动重跑并在通过后记账；若有非幂等副作用，请人工核对后再决定。',
    docs: 'docs/execution-contract.md',
    autoRepairs: ['幂等任务（retrySafe）自动重跑'],
  }) },
  { match: /stalled: no unit progress/i, build: () => ({
    tier: 'auto', title: '单元停滞（agent 活着但不产出）',
    cause: '超过停滞阈值没有新检查点/结果/日志写入，判定为僵死。',
    tried: ['只杀 agent 后代（保留 launcher 干净收尾）', '按块重试预算自动重开'],
    fix: '无需处理；若频繁出现，检查该宿主账号额度/网络，或调 ORCH_UNIT_STALL_MS。',
    docs: 'docs/execution-contract.md',
    autoRepairs: ['停滞检测→自动关窗→自动重跑'],
  }) },
  { match: /popup failed|WINDOW NOT VISIBLE|popup FAILED/i, build: () => ({
    tier: 'auto', title: '窗口未能真正弹出',
    cause: '窗口进程起来了但未被置前/不可见，按「没弹」处理以免假绿。',
    tried: ['激活重试（AttachThreadInput+SwitchToThisWindow）', 'Z 序排名裁决'],
    fix: '无需处理；若持续失败可设 ORCH_WINDOW_NOACTIVATE=1 接受不打扰模式，或改用 headless。',
    docs: 'docs/execution-contract.md',
    autoRepairs: ['激活重试', '任务栏闪烁兜底'],
  }) },
];

export function classifyFailure(error) {
  const raw = error && error.message ? String(error.message) : String(error || '');
  for (const rule of RULES) {
    const m = raw.match(rule.match);
    if (m) return { raw, ...rule.build(m) };
  }
  return {
    raw,
    tier: 'guidance',
    title: '未分类的失败',
    cause: raw || '（无错误信息）',
    tried: ['按已知模式分类（未命中）'],
    fix: '带 ORCH_DEBUG=1 重跑可获得完整栈帧；若可稳定复现，请把该输出附到 issue/记录里。',
    docs: 'docs/execution-contract.md',
    autoRepairs: [],
  };
}

// 机器可调用契约保持不变：首行仍是 `[orchestrator] FATAL: <原因>`；
// 之后追加人类可读的 cause/tried/fix 指引（修不了的失败必须有出路，不许只抛错误）。
export function formatFailureLines(error, { prefix = '[orchestrator]' } = {}) {
  // 允许直接吃 classifyFailure 的返回值（调用方已经分好类时不再二次分类）。
  const c = error && typeof error === 'object' && error.tier && 'raw' in error ? error : classifyFailure(error);
  const lines = [`${prefix} FATAL: ${c.raw}`];
  if (c.tier !== 'auto') {
    lines.push(`${prefix} cause: ${c.cause}`);
    if (c.tried.length) lines.push(`${prefix} tried: ${c.tried.join(' | ')}`);
    lines.push(`${prefix} fix: ${c.fix}`);
    if (c.docs) lines.push(`${prefix} docs: ${c.docs}`);
  }
  return lines;
}
