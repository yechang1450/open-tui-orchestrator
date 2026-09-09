import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 维护锁：编排器在对自身做升级/优化/维护/更新等改动期间上锁。上锁期间任何 agent
// 调用编排器（--run-windows/--spawn/--resume-run/preflight/force --assert 等动作入口）
// 都只得到 MAINTENANCE_MESSAGE 一句话——本轮跳过 orchestrator、由发起对话直接执行。
// 锁是礼让性门禁而非安全边界：文件损坏/过期一律 fail-open 视为未锁，绝不把工具卡死。
export const MAINTENANCE_MESSAGE = 'open-tui-orchestrator正在维护更新，本轮跳过orchestrator直接开始执行';
export const DEFAULT_TTL_MINUTES = 180;
export const MAX_TTL_MINUTES = 24 * 60;

// 锁全局唯一（按用户），与工作区无关：任何工作区里的调用都能看到同一把锁。
// ORCH_MAINTENANCE_LOCK 覆盖默认路径（测试/隔离用）。
export function maintenanceLockPath(env = process.env) {
  const override = String(env.ORCH_MAINTENANCE_LOCK || '').trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.open-tui-orchestrator', 'maintenance-lock.json');
}

function parseLockJson(raw) {
  const text = String(raw);
  return JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
}

export function readMaintenanceLock(env = process.env, now = Date.now()) {
  const file = maintenanceLockPath(env);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { locked: false }; }
  let data;
  try { data = parseLockJson(raw); } catch { return { locked: false, invalid: true }; }
  const expiresAt = Number(data && data.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    // 过期即解锁并顺手清理（维护方崩溃/忘记解锁也不会把编排器关死）。
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    return { locked: false, expired: true };
  }
  return {
    locked: true,
    reason: String((data && data.reason) || ''),
    startedAt: Number(data && data.startedAt) || null,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
  };
}

export function lockedForMaintenance(env = process.env) {
  try { return readMaintenanceLock(env).locked; } catch { return false; }
}

export function acquireMaintenanceLock({ reason = '', ttlMinutes = DEFAULT_TTL_MINUTES, env = process.env } = {}) {
  const ttl = Number(ttlMinutes);
  const minutes = Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, MAX_TTL_MINUTES) : DEFAULT_TTL_MINUTES;
  const file = maintenanceLockPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = Date.now();
  const data = { version: 1, pid: process.pid, reason: String(reason || ''), startedAt: now, expiresAt: now + Math.round(minutes * 60000) };
  // tmp+rename 原子落盘，读者永远只看到完整 JSON 或不存在。
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return data;
}

export function releaseMaintenanceLock(env = process.env) {
  try {
    const file = maintenanceLockPath(env);
    fs.rmSync(file, { force: true });
    // 顺手收掉空目录（仅当为空才成功，绝不误删其它内容）。
    try { fs.rmdirSync(path.dirname(file)); } catch { /* ignore */ }
    return true;
  } catch { return false; }
}
