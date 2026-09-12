import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// 单元载体（carrier）解析——工具适配 agent 的载体分级层。
//
//   stdio = 无控制台的隐藏进程（print 类 CLI：自带一次性输出模式，不需要终端）
//   pty   = ConPTY 伪终端宿主（TUI 类 CLI：需要真实终端，工具给它一个真实但完全不可见的控制台）
//
// 两载体共享同一条契约：同样的启动器 ps1、pidf、进程身份、租约、恢复/收编。
// PTY 引擎解析顺序：工具自带安装（scripts/node_modules，dev 仓库与发行副本同构）
// → 常规包解析。绝不静默借用其它 agent 安装目录里的副本（各副本独立升级、独立封印）。
const require = createRequire(import.meta.url);
const CORE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function normalizeUnitCarrier(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'pty' || v === 'stdio') return v;
  throw new Error('UNSUPPORTED_UNIT_CARRIER: ' + value + ' (use pty|stdio)');
}

// 优先级：显式 ORCH_UNIT_CARRIER > agent 画像声明（registry/unit profile）> stdio 兜底。
export function effectiveUnitCarrier(env = process.env, agentConfig = {}) {
  return normalizeUnitCarrier(env.ORCH_UNIT_CARRIER)
    || normalizeUnitCarrier(agentConfig.carrier)
    || 'stdio';
}

function ptyCandidates() {
  return [
    path.join(CORE_DIR, '..', 'node_modules', '@lydell', 'node-pty', 'index.js'),
    '@lydell/node-pty',
  ];
}

export function ptyAvailability() {
  for (const candidate of ptyCandidates()) {
    try {
      const resolved = path.isAbsolute(candidate) ? candidate : require.resolve(candidate);
      if (fs.existsSync(resolved)) return { ok: true, resolved };
    } catch { /* try the next candidate */ }
  }
  return { ok: false, tried: ptyCandidates() };
}

export function loadPtyEngine() {
  const availability = ptyAvailability();
  if (!availability.ok) {
    throw new Error('PTY_CARRIER_UNAVAILABLE: @lydell/node-pty not found (tried: ' + availability.tried.join(' | ')
      + '). Run `npm run setup` (or npm install --prefix scripts) to materialize the PTY engine, or fall back with ORCH_UNIT_CARRIER=stdio / --mode window.');
  }
  return require(availability.resolved);
}
