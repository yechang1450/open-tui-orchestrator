#!/usr/bin/env node
/**
 * gate.mjs — the machine gate the release policy refers to, runnable from inside the repo.
 *
 *   node scripts/gate.mjs --all          # every criterion, in order
 *   node scripts/gate.mjs --suite        # L1: the offline regression suite
 *   node scripts/gate.mjs --doctor       # L2a: host resolution (hostError must be null)
 *   node scripts/gate.mjs --canary       # L2b: a deliberately failing test must go red
 *   node scripts/gate.mjs --unknown-run  # L3: an unknown run id fails closed, cleanly
 *   node scripts/gate.mjs --consistency  # L4: version / seal / docs / suite total agree
 *
 * Rules that make it a gate rather than a smoke test:
 *   - every criterion prints command / expectation / actual;
 *   - a value that cannot be read counts as failure ("unknown is failure");
 *   - exit 0 only if every requested criterion passed; any failure exits 1;
 *   - L2b keeps the criteria themselves honest: it proves a red case still goes red;
 *   - the shell's user-level `ORCH_SPAWN_MODE` (kept for manual runs) is reported, never
 *     inherited: children are pinned to headless, so criteria cannot change with the shell
 *     and nothing pops up (2026-09-16 ruling: 判据随壳变色不可接受).
 *
 * Environment: the suite follows the documented convention (`ORCH_AGENT` defaults to
 * `codex` here; the codex CLI must be resolvable — see README "Test-env requirement").
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {coordinatorDir} from './core/leases.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT = String(process.env.ORCH_GATE_AGENT || 'codex').trim();
const args = new Set(process.argv.slice(2));
const wants = (flag) => args.has(flag) || args.has('--all') || args.size === 0;
const results = [];
// 判据不得随壳变色：本壳的用户级 ORCH_SPAWN_MODE 只报告、不继承；子进程一律显式钉 headless。
const SHELL_SPAWN_MODE = String(process.env.ORCH_SPAWN_MODE || '').trim() || '(unset)';
console.log(`  [gate] shell ORCH_SPAWN_MODE=${SHELL_SPAWN_MODE}; children pinned to headless (zero popups)`);

function check(id, title, ok, lines) {
  results.push({id, ok});
  console.log(`  ${id} ${title}`);
  for (const line of lines) console.log(`    ${line}`);
  console.log(`    → ${id} ${ok ? 'PASS' : 'FAIL'}`);
}

function node(argsArr, opts = {}) {
  // 非交互自动化一律显式 headless：gate 的子进程绝不继承本壳 ORCH_SPAWN_MODE（零弹窗）。
  const env = {...(opts.env || process.env), ORCH_SPAWN_MODE: 'headless'};
  const r = spawnSync(process.execPath, argsArr, {cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: opts.timeout || 900000, env});
  return {status: r.status, out: (r.stdout || '') + (r.stderr || '')};
}

// ---------------------------------------------------------------- L1: the suite
function suite() {
  const files = fs.readdirSync(path.join(REPO, 'test')).filter((n) => n.endsWith('.test.mjs')).sort().map((n) => path.join('test', n));
  const env = {...process.env, ORCH_AGENT: process.env.ORCH_AGENT || AGENT};
  console.error(`  [gate] running ${files.length} test files (this takes minutes)…`);
  const r = node(['--test', '--test-concurrency=3', ...files], {env});
  const num = (key) => {
    const m = r.out.match(new RegExp('^ℹ ' + key + ' (\\d+)$', 'm'));
    return m ? Number(m[1]) : null;
  };
  const pass = num('pass'), fail = num('fail'), skipped = num('skipped'), cancelled = num('cancelled');
  const missing = [['pass', pass], ['fail', fail], ['skipped', skipped]].filter(([, v]) => v === null).map(([k]) => k);
  if (missing.length) return check('L1', 'offline regression suite', false, [`expected: pass>0 / fail==0 / skipped==0 / exit==0`, `actual: missing ${missing.join(', ')} ⇒ unknown is failure`]);
  const ok = pass > 0 && fail === 0 && skipped === 0 && r.status === 0;
  check('L1', 'offline regression suite', ok, [
    `expected: pass>0 / fail==0 / skipped==0 / exit==0`,
    `actual: pass=${pass} fail=${fail} skipped=${skipped} cancelled=${cancelled} exit=${r.status}`,
  ]);
  return pass;
}

// ------------------------------------------------- L2a: host resolution (doctor)
function doctor() {
  const r = node(['cli.mjs', '--agent', AGENT, '--doctor']);
  const m = r.out.match(/"hostError"\s*:\s*(null|"[^"]*")/);
  check('L2a', `host resolution (\`--agent ${AGENT} --doctor\`)`, !!m && m[1] === 'null', [
    'expected: "hostError": null',
    `actual: hostError=${m ? m[1] : 'not found'} (exit=${r.status})`,
  ]);
}

// ----------------------------------------- L2b: the criteria themselves can go red
function canary() {
  const file = path.join(REPO, 'test', 'zzz-gate-canary.test.mjs');
  fs.writeFileSync(file, "import test from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('gate canary (must fail)', () => { assert.equal(1, 2); });\n");
  try {
    const r = node(['--test', file]);
    const red = r.status !== 0 && /^ℹ fail 1$/m.test(r.out);
    check('L2b', 'red-capability canary (a failing test must fail)', red, [
      'expected: a deliberately failing test exits non-zero with `ℹ fail 1`',
      `actual: exit=${r.status}, fail line ${/^ℹ fail 1$/m.test(r.out) ? 'present' : 'absent'}`,
    ]);
  } finally {
    fs.rmSync(file, {force: true});
  }
}

// ------------------------------------------------------ L3: unknown run, cleanly
function unknownRun() {
  const id = 'nosuch-run-gate-' + Math.random().toString(16).slice(2, 8);
  const r = node(['cli.mjs', '--verify-run', id]);
  const frames = (r.out.match(/^\s+at /gm) || []).length;
  const named = r.out.includes('Run not found');
  check('L3', 'unknown run fails closed with one diagnostic line', r.status !== 0 && frames === 0 && named, [
    'expected: non-zero exit, no Node stack frames, mentions `Run not found`',
    `actual: exit=${r.status}, stack frames=${frames}, Run not found=${named}`,
  ]);
}

// ----------------------------------- L4: version / seal / docs / suite total agree
function consistency(suitePass) {
  const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
  const core = (read('scripts/core/contracts.mjs').match(/CORE_VERSION\s*=\s*'([^']+)'/) || [])[1];
  const seal = JSON.parse(read('release.json'));
  const files = Object.keys(seal.files || {}).length;
  const runtime = Object.keys(seal.runtimeFiles || {}).length;
  const lines = [`expected: CORE_VERSION == release.json.coreVersion; README / README-zh / release-policy carry the live version, file counts and suite total`,
    `actual: core=${core} sealCore=${seal.coreVersion} files=${files} runtime=${runtime}`];
  let ok = !!core && seal.coreVersion === core;
  if (!ok) lines.push(`core version and the seal disagree ⇒ FAIL`);

  const sources = {
    'README.md': [/core is ([\d.]+), with (\d+)\/(\d+) offline tests passing/, 0, 1, 2],
    'README-zh.md': [/当前通用核心为 ([\d.]+)，离线回归为 (\d+)\/(\d+) 通过/, 0, 1, 2],
    'docs/release-policy.md': [/当前源码封印记录通用核心 ([\d.]+)、(\d+) 个核心文件和 (\d+) 个运行时文件。最新离线回归为 (\d+)\/(\d+) 通过/, 0, 3, 4],
  };
  const totals = new Set();
  for (const [rel, [pattern, ci, pi, ti]] of Object.entries(sources)) {
    const m = read(rel).match(pattern);
    if (!m) { ok = false; lines.push(`${rel}: no version line found ⇒ FAIL`); continue; }
    const g = m.slice(1);
    if (g[ci] !== core) { ok = false; lines.push(`${rel}: core ${g[ci]} != ${core} ⇒ FAIL`); }
    if (g[pi] !== g[ti]) { ok = false; lines.push(`${rel}: regression total is not all-green ${g[pi]}/${g[ti]} ⇒ FAIL`); }
    totals.add(`${g[pi]}/${g[ti]}`);
  }
  if (totals.size > 1) { ok = false; lines.push(`the three documents disagree on the regression total ${[...totals].join(' ')} ⇒ FAIL`); }
  else if (totals.size === 1) lines.push(`three documents agree on the regression total: ${[...totals][0]}`);

  const policy = read('docs/release-policy.md').match(sources['docs/release-policy.md'][0]);
  if (policy && (Number(policy[2]) !== files || Number(policy[3]) !== runtime)) { ok = false; lines.push(`documented seal counts ${policy[2]}/${policy[3]} != ${files}/${runtime} ⇒ FAIL`); }
  if (suitePass !== null && totals.size === 1 && [...totals][0] !== `${suitePass}/${suitePass}`) { ok = false; lines.push(`documented total ${[...totals][0]} != measured suite ${suitePass} ⇒ FAIL`); }
  else if (suitePass !== null) lines.push(`documented total matches the measured suite: ${suitePass}`);

  // Resolving the coordinator also sweeps stale tickets (entry-time reclamation), so any
  // ticket older than ten minutes left behind means that reclamation is broken.
  let coordinator = null;
  try { coordinator = coordinatorDir(REPO); } catch (error) { lines.push(`coordinator directory could not be resolved (${error.message})`); }
  if (coordinator && fs.existsSync(coordinator)) {
    const cutoff = Date.now() - 600000;
    const stale = fs.readdirSync(coordinator).filter((n) => n.startsWith('lock-')).filter((n) => fs.statSync(path.join(coordinator, n)).mtimeMs < cutoff);
    if (stale.length) { ok = false; lines.push(`${stale.length} stale mutex ticket(s) older than ten minutes survive reclamation ⇒ FAIL: ${stale.slice(0, 5).join(' ')}`); }
    else lines.push('no stale mutex tickets in the coordinator directory');
  } else {
    lines.push('coordinator directory not present (nothing to sweep)');
  }
  check('L4', 'version / seal / docs / suite total cross-check', ok, lines);
}

let measuredSuite = null;
if (wants('--suite')) measuredSuite = suite();
if (wants('--doctor')) doctor();
if (wants('--canary')) canary();
if (wants('--unknown-run')) unknownRun();
if (wants('--consistency')) consistency(measuredSuite);

const failed = results.filter((r) => !r.ok).map((r) => r.id);
console.log(`ORCH_GATE: ${failed.length ? 'FAIL (' + failed.join(', ') + ')' : 'PASS'} — ${results.length} criteria`);
process.exitCode = failed.length ? 1 : 0;
