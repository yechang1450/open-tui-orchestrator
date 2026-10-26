// unit-memory.mjs —— 通用「单元内存画像 + 合并适配」：底层机制，不针对任何宿主做专项。
// 设计规则（硬约束）：
//   1) 只有一套机制；每个宿主（含未来接入的）都只是学习表里的一行数据；
//   2) 本文件内不得出现任何 per-agent 分支（if agent === 'xxx' 之类）；
//   3) 默认值 / 安全系数 / 底限全部通用且可用环境变量配置。
// 判据：test/unit-memory.test.mjs（红能力：每个断言都能被反例击红）。
import fs from 'node:fs';
import path from 'node:path';

const MEM_STORE_SCHEMA = 1;

export const MEM_DEFAULTS = Object.freeze({
  floorMb: 1000,      // 系统可用内存硬底：全并发执行也不得让可用内存低于它（ORCH_MIN_FREE_MEM_MB）
  defaultUnitMb: 640, // 未知宿主的保守单单元峰值（ORCH_UNIT_MEM_DEFAULT_MB）
  safety: 1.3,        // 学习值安全系数：estimate = p90 × safety（ORCH_UNIT_MEM_SAFETY）
  minSamples: 3,      // 学习生效所需的最少样本数（ORCH_UNIT_MEM_MIN_SAMPLES）
  maxSamples: 50,     // 每宿主保留的最近样本数
  blockGrowth: 0.15,  // 块内每多一个任务的成本增长（ORCH_UNIT_MEM_BLOCK_GROWTH，必须 <1 才能保证合并必降账）
  maxTasksPerBlock: 0, // 单块题数上限（ORCH_UNIT_MEM_MAX_TASKS_PER_BLOCK）；0 = 不限制（保持既有行为）
});

export function memConfig(env = process.env) {
  const num = (key, fallback) => {
    const v = Number(String(env[key] ?? '').trim());
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const rawText = String(env.ORCH_UNIT_MEM_BLOCK_GROWTH ?? '').trim();
  const growthRaw = rawText === '' ? NaN : Number(rawText);   // 空串≠0：未设置必须回落到默认值
  const growth = Number.isFinite(growthRaw) && growthRaw >= 0 ? Math.min(growthRaw, 0.9) : MEM_DEFAULTS.blockGrowth;
  // 单块题数上限：0 是合法值（= 不限制），故不能走 num()（它只接受 >0）。空串/非数 ⇒ 回落默认 0。
  const capRaw = String(env.ORCH_UNIT_MEM_MAX_TASKS_PER_BLOCK ?? '').trim();
  const capNum = capRaw === '' ? NaN : Number(capRaw);
  const maxTasksPerBlock = Number.isFinite(capNum) && capNum >= 0 ? Math.floor(capNum) : MEM_DEFAULTS.maxTasksPerBlock;
  return {
    floorMb: num('ORCH_MIN_FREE_MEM_MB', MEM_DEFAULTS.floorMb),
    defaultUnitMb: num('ORCH_UNIT_MEM_DEFAULT_MB', MEM_DEFAULTS.defaultUnitMb),
    safety: num('ORCH_UNIT_MEM_SAFETY', MEM_DEFAULTS.safety),
    minSamples: Math.max(1, Math.floor(num('ORCH_UNIT_MEM_MIN_SAMPLES', MEM_DEFAULTS.minSamples))),
    blockGrowth: growth,
    maxTasksPerBlock,
  };
}

export function emptyStore() {
  return {schema: MEM_STORE_SCHEMA, agents: {}};
}

// 学习表位置：机器级（跨工作区共享）。env ORCH_UNIT_MEM_STORE 可覆盖（测试隔离用）。
export function unitMemoryStorePath(env = process.env) {
  const override = String(env.ORCH_UNIT_MEM_STORE || '').trim();
  if (override) return override;
  return path.join(osTmp(), 'orchestrator', 'unit-memory.json');
}
function osTmp() {
  return process.env.TEMP || process.env.TMP || '/tmp';
}

// 读学习表；任何异常（文件缺失 / JSON 坏 / 结构不对）都回退为空表（fail-open 到默认值）。
export function loadUnitMemory(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.agents || typeof raw.agents !== 'object') return emptyStore();
    const agents = {};
    for (const [key, row] of Object.entries(raw.agents)) {
      const peaks = Array.isArray(row?.peaks)
        ? row.peaks.filter((n) => Number.isFinite(n) && n > 0).map((n) => Math.round(n)).slice(-MEM_DEFAULTS.maxSamples)
        : [];
      agents[String(key)] = {peaks};
    }
    return {schema: MEM_STORE_SCHEMA, agents};
  } catch {
    return emptyStore();
  }
}

// 原子写（tmp → rename），失败不抛（学习数据不值得让运行失败）。
// 2026-10-26（P8）：原来一次写不成直接 return false 且完全静默 —— 而 renameSync 被并发读或
// 杀软扫描占住时是 EPERM/EBUSY 这类**瞬态**错误，单次失败就丢掉一整条峰值样本。样本丢了永远到
// 不了 minSamples，unitMb 就一直停在默认 640MB（同源宿主实测 995/1528MB）⇒ 内存拟合低估 ⇒ 过并发。
// 现在退避重试 3 次（50/100ms 同步睡），仍失败才落一行 stderr —— 尽力而为但不装死。
// 刻意不加跨进程锁：这是低价值可再生的学习数据，加锁的延迟代价远大于丢一条样本（minSamples 会随
// 样本累积自然收敛），而临界区只有毫秒级。
export function saveUnitMemory(file, store) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
      fs.renameSync(tmp, file);
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1)); } catch { /* no Atomics on this host */ }
      }
    }
  }
  try { fs.rmSync(tmp, {force: true}); } catch { /* best effort */ }
  try { process.stderr.write('[unit-memory] save failed after 3 attempts (' + String(lastError && lastError.message || lastError) + '); the peak sample for this run is lost\n'); } catch { /* nothing left */ }
  return false;
}

export function percentile(nums, p) {
  const list = (nums || []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!list.length) return null;
  const idx = Math.min(list.length - 1, Math.max(0, Math.ceil(p * list.length) - 1));
  return list[idx];
}

// ===== 自我观测（v4 / 2026-10-26）=====
// 设计边界（三轮审核后收窄）：这里**只记录，不消费**。
// - 不改 unitEstimateMb 口径（现有 236 条样本里带 tasks 的有 0 条，归一化首日全部回退默认值，收益为 0）
// - 不改 admitCount 语义（它是「每窗口」的量；改成「每任务」会让 plannerBlockCeiling 从 7 变 35，
//   并发准入直接放开过度）
// - 不改 blockGrowth（同宿主 spread 实测 8.3x/9.2x，g=0.15 最多只能解释 2.65x ⇒ 主因是运行载体
//   不是题数，必须靠 mode 字段先分层，而不是先回归）
// 目的：让「按 tasks × mode 分层统计」这条假设**可被验证**——先攒 30 条带 tasks 且覆盖 ≥2 种 mode
// 的样本，再谈算法。模板：unitEstimateMb 的注释与判据保持原样。
const MEM_STORE_SCHEMA_V2 = 2;

// v2 表路径必须从 ORCH_UNIT_MEM_STORE **派生**，不能另起环境变量。
// 理由：boundaries.test:37 / caller-driven.test:76 / cli-surface.test:36 三处靠 ORCH_UNIT_MEM_STORE
// 做测试隔离；另起变量会让 v2 表落到机器级共用位置，测试互相污染（现表里已混入
// fakeunit / drillunit / fakeprint 三个测试宿主的样本）。
export function unitMemoryStorePathV2(env = process.env) {
  return path.join(path.dirname(unitMemoryStorePath(env)), 'unit-memory-v2.json');
}

function emptyStoreV2() { return {schema: MEM_STORE_SCHEMA_V2, agents: {}}; }

export function loadUnitMemoryV2(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!raw || raw.schema !== MEM_STORE_SCHEMA_V2 || !raw.agents || typeof raw.agents !== 'object') return emptyStoreV2();
    const agents = {};
    for (const [id, row] of Object.entries(raw.agents)) {
      // 只留形状正确的样本：mb 必须正数、at 必须有限。tasks/mode 允许 null/unknown（观测期容忍）。
      const peaks = Array.isArray(row?.peaks) ? row.peaks.filter(p =>
        p && Number.isFinite(p.mb) && p.mb > 0 && Number.isFinite(p.at)
      ) : [];
      if (peaks.length) agents[id] = {peaks};
    }
    return {schema: MEM_STORE_SCHEMA_V2, agents};
  } catch { return emptyStoreV2(); }
}

// 只写不读。mode 是关键维度：审核实测同宿主内 spread 8.3x/9.2x，载体（window/pty/headless）
// 差异远大于题数差异，不记 mode 就没法分层。
export function recordUnitPeakV2(store, agent, peakMb, tasks, mode) {
  const key = String(agent || 'unknown');
  if (!Number.isFinite(peakMb) || peakMb <= 0) return store;
  if (!store || store.schema !== MEM_STORE_SCHEMA_V2) return store;
  const row = store.agents[key] || {peaks: []};
  row.peaks = [...row.peaks, {
    mb: Math.round(peakMb),
    tasks: Number.isInteger(tasks) && tasks >= 1 ? tasks : null,
    mode: (mode && String(mode)) || 'unknown',
    at: Date.now(),
  }].slice(-MEM_DEFAULTS.maxSamples);
  store.agents[key] = row;
  return store;
}

export function recordUnitPeak(store, agent, peakMb) {
  const key = String(agent || 'unknown');
  if (!Number.isFinite(peakMb) || peakMb <= 0) return store;
  const row = store.agents[key] || {peaks: []};
  row.peaks = [...row.peaks, Math.round(peakMb)].slice(-MEM_DEFAULTS.maxSamples);
  store.agents[key] = row;
  return store;
}

// 单单元内存估计：样本够 → p90 × 安全系数；否则 → 通用默认值。宿主无关。
export function unitEstimateMb(store, agent, cfg = memConfig()) {
  const peaks = store?.agents?.[String(agent || 'unknown')]?.peaks || [];
  if (peaks.length >= cfg.minSamples) {
    const p90 = percentile(peaks, 0.9);
    if (Number.isFinite(p90)) return Math.max(1, Math.round(p90 * cfg.safety));
  }
  return Math.round(cfg.defaultUnitMb);
}

// 现在最多能放几个单元：floor((free − 底线) / 单元估计)。这是旧公式 floor(free/1000)×2 的诚实泛化——
// 同样只做准入上限，但用的是按宿主学习的真实单元大小（宿主无关，无分支）。
export function admitCount(freeMb, unitMb, cfg = memConfig()) {
  const free = Number(freeMb);
  const unit = Math.max(1, Number(unitMb) || cfg.defaultUnitMb);
  if (!Number.isFinite(free)) return 1;
  return Math.max(0, Math.floor((free - cfg.floorMb) / unit));
}

// 块的估算成本（单元数）：1 + g×(块内任务数−1)。g<1 是收敛保证：每合并一次，总账必降。
function blockCost(block, growth) {
  const tasks = (block?.tasks || []).length;
  return 1 + growth * Math.max(0, tasks - 1);
}

function hintSet(block) {
  const out = new Set();
  for (const task of block?.tasks || []) for (const h of task?.conflict_hints || []) out.add(String(h));
  return out;
}

// 选合并对：① 依赖对（本就该串行）→ ② 冲突提示有交集的相邻对 → ③ 任务数最多的一对（同数则取靠后者，尾部吸收溢出）。
function pickPair(blocks, maxTasksPerBlock = 0) {
  const sizeOf = (b) => (b.tasks || []).length;
  const overCap = (i, j) => maxTasksPerBlock > 0 && sizeOf(blocks[i]) + sizeOf(blocks[j]) > maxTasksPerBlock;
  const idxOf = new Map(blocks.map((b, i) => [b, i]));
  for (let j = 0; j < blocks.length; j += 1) {
    for (const dep of blocks[j].dependsOn || []) {
      const i = blocks.findIndex((b) => b.title === dep || (b.tasks || []).some((t) => t.id === dep));
      if (i >= 0 && i !== j) {
        const [a, b] = [Math.min(i, j), Math.max(i, j)];
        // 依赖对是「本就该串行」的首选，但仍不得越过题数上限（越界则继续找其它对）。
        if (!overCap(a, b)) return [a, b, 'dependency'];
      }
    }
  }
  for (let i = 0; i < blocks.length - 1; i += 1) {
    const a = hintSet(blocks[i]);
    if (!a.size) continue;
    const b = hintSet(blocks[i + 1]);
    for (const h of b) if (a.has(h)) { if (!overCap(i, i + 1)) return [i, i + 1, 'conflict-hint']; }
  }
  let best = null;
  for (let i = 0; i < blocks.length; i += 1) {
    for (let j = i + 1; j < blocks.length; j += 1) {
      if (overCap(i, j)) continue;                       // 越过上限的对不参与「最大」选择
      const weight = (blocks[i].tasks || []).length + (blocks[j].tasks || []).length;
      // 同权重取「靠后者」：溢出在尾部吸收（9 题并 8 块 ⇒ 并 [8+9]「第九块并入第八块」），与
      // capPlanBlocks 的连续区段约定及容量验收契约一致；取靠前者会把合并推到头部（并 [1+2]），
      // 既违背契约，又让合并窗的第二个前置任务无法在放行前报到（探针互等 = 死锁）。
      if (!best || weight >= best[2]) best = [i, j, weight];
    }
  }
  if (best) return [best[0], best[1], 'largest'];
  // 所有候对都会越过上限 ⇒ 无可用合并对（调用方据此停止，保留既有块划分）。
  return null;
}

// 把两个块并成一个「串行块」：tasks 按原顺序拼接；dependsOn 合并、去掉指向被并块自身的边，
// 其余块里指向 a/b 的边改指合并后的块（保证依赖图不碎）。
function mergeBlocks(blocks, i, j, seq) {
  const [a, b] = [blocks[i], blocks[j]];
  const mergedTasks = [...(a.tasks || []), ...(b.tasks || [])];
  const own = new Set([a.title, b.title]);
  const deps = [...new Set([...(a.dependsOn || []), ...(b.dependsOn || [])])].filter((d) => !own.has(d));
  const merged = {title: `fit-merged-${seq}`, type: 'linked', dependsOn: deps, tasks: mergedTasks};
  const rest = blocks.filter((_, k) => k !== i && k !== j).map((bl) => ({
    ...bl,
    dependsOn: (bl.dependsOn || []).map((d) => (own.has(d) ? merged.title : d)),
  }));
  const at = Math.min(i, j);
  rest.splice(at, 0, merged);
  return rest;
}

// 合并适配（纯函数）：F − Σest ≥ floor 不满足 ⇒ 依次合并，直到满足、只剩一块、或所有候对都越过题数上限。
// 返回 {blocks, unitMb, estMb, freeMb, floorMb, blockGrowth, maxTasksPerBlock, merges, fits}；merges 记录每一步（可审计）。
// 单块题数上限（cfg.maxTasksPerBlock，0=不限制）用于让「内存合并」不突破规划层已定的粒度：
//   实测（exam-v6 五轮）opencode unitMb=995 ⇒ 19 题并成 8 块（B1 吞 12）、codex unitMb=1528 ⇒ 4 块（B1 并 16），
//   一次起窗失败即连坐十余题；有上限后最大的块被钉在给定题数。
export function estimateBlockMemoryMb(block, unitMb, cfg = memConfig()) {
  const unit = Math.max(1, Number(unitMb) || cfg.defaultUnitMb);
  const tasks = Array.isArray(block?.tasks) ? block.tasks.length : 0;
  return Math.round((1 + cfg.blockGrowth * Math.max(0, tasks - 1)) * unit);
}

export function fitBlocks(blocks, freeMb, unitMb, cfg = memConfig()) {
  let cur = (blocks || []).map((b) => ({...b}));
  const merges = [];
  const cap = Number(cfg.maxTasksPerBlock) > 0 ? Math.floor(Number(cfg.maxTasksPerBlock)) : 0;
  const estMb = (bs) => bs.reduce((sum, b) => sum + blockCost(b, cfg.blockGrowth) * unitMb, 0);
  const fits = (bs) => Number.isFinite(freeMb) ? freeMb - estMb(bs) >= cfg.floorMb : true;
  let seq = 1;
  while (cur.length > 1 && !fits(cur)) {
    const pair = pickPair(cur, cap);
    if (!pair) {                                   // 所有候对都会越过上限 ⇒ 保留既有块划分
      merges.push({step: seq, why: 'ceiling', merged: []});
      break;
    }
    const [i, j, why] = pair;
    const titles = [cur[i].title, cur[j].title];
    cur = mergeBlocks(cur, i, j, seq);
    merges.push({step: seq, why, merged: titles});
    seq += 1;
  }
  return {blocks: cur, unitMb, estMb: estMb(cur), freeMb, floorMb: cfg.floorMb, blockGrowth: cfg.blockGrowth, maxTasksPerBlock: cap, merges, fits: fits(cur)};
}

// 供日志用的一行描述。
export function describeFit(result) {
  const m = result.merges.length ? result.merges.map((x) => `${x.step}:${x.why}(${x.merged.join('+')})`).join(' ') : 'none';
  return `[mem-fit] units=${result.blocks.length} unitMb=${result.unitMb} growth=${result.blockGrowth} estMb=${result.estMb} freeMb=${result.freeMb} floorMb=${result.floorMb} fits=${result.fits} merges=${m}`;
}
