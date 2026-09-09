#!/usr/bin/env node
/**
 * maintenance-lock — open-tui-orchestrator 维护锁 CLI。
 *
 * 对编排器自身做升级/优化/维护/更新等改动前先上锁；上锁期间任何 agent 调用编排器
 * 都只返回一句话：open-tui-orchestrator正在维护更新，本轮跳过orchestrator直接开始执行
 *
 *   node scripts/maintenance-lock.mjs lock [--reason "文字"] [--ttl-minutes N]
 *   node scripts/maintenance-lock.mjs unlock
 *   node scripts/maintenance-lock.mjs status
 *
 * 锁默认 180 分钟自动过期（上限 24h），过期/损坏均 fail-open 视为未锁；
 * 路径可用 ORCH_MAINTENANCE_LOCK 覆盖（默认 ~/.open-tui-orchestrator/maintenance-lock.json）。
 */
import { acquireMaintenanceLock, releaseMaintenanceLock, readMaintenanceLock, maintenanceLockPath, MAINTENANCE_MESSAGE } from './core/maintenance-lock.mjs';

const args = process.argv.slice(2);
const cmd = String(args[0] || 'status').toLowerCase();

function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

if (cmd === 'lock') {
  const reason = String(flagValue('--reason') || '').trim();
  const ttl = flagValue('--ttl-minutes');
  const data = acquireMaintenanceLock({ reason, ttlMinutes: ttl === undefined ? undefined : Number(ttl) });
  console.log('LOCKED: ' + MAINTENANCE_MESSAGE);
  console.log(JSON.stringify({ lock: maintenanceLockPath(), reason: data.reason, startedAt: new Date(data.startedAt).toISOString(), expiresAt: new Date(data.expiresAt).toISOString() }, null, 2));
} else if (cmd === 'unlock') {
  const had = readMaintenanceLock().locked;
  releaseMaintenanceLock();
  console.log(had ? 'unlocked: maintenance lock released.' : 'unlocked: no active maintenance lock.');
} else if (cmd === 'status') {
  const st = readMaintenanceLock();
  if (st.locked) {
    console.log('LOCKED: ' + MAINTENANCE_MESSAGE);
    console.log(JSON.stringify({ lock: maintenanceLockPath(), reason: st.reason, startedAt: st.startedAt ? new Date(st.startedAt).toISOString() : null, expiresAt: st.expiresAt ? new Date(st.expiresAt).toISOString() : null }, null, 2));
  } else {
    console.log('not locked' + (st.expired ? ' (previous lock expired and was cleaned up)' : '') + (st.invalid ? ' (invalid lock file ignored; fail-open)' : ''));
  }
} else {
  console.log('Usage: node scripts/maintenance-lock.mjs lock [--reason "文字"] [--ttl-minutes N] | unlock | status');
  process.exitCode = 2;
}
