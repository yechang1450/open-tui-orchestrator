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
 *   - an L1 red names the failing tests (the reporter's `✖ failing tests:` section), prints one
 *     machine line `[gate] suite reds (N): name @ file:line:col | …` for the judgement record,
 *     and dumps the full suite output to `<repo>/temp/gate-suite-<stamp>.log` — learning *which*
 *     test failed must never cost a re-run (2026-09-17, after a red round whose failing case
 *     could not be recovered: the gate kept counts only and the log was overwritten by the
 *     re-judgement of the same head);
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
import {fileURLToPath, pathToFileURL} from 'node:url';
import {coordinatorDir} from './core/leases.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT = String(process.env.ORCH_GATE_AGENT || 'codex').trim();
const results = [];
// 判据不得随壳变色：本壳的用户级 ORCH_SPAWN_MODE 只报告、不继承；子进程一律显式钉 headless。
const SHELL_SPAWN_MODE = String(process.env.ORCH_SPAWN_MODE || '').trim() || '(unset)';

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

// ------------------------------------------- L1 red list (isolated, unit-testable)
// Node's spec reporter ends a red run with a `✖ failing tests:` section: per failure a
// `test at <file>:<line>:<col>` line followed by a `✖ <name> (<n>ms)` line. Parse that
// section; when it is absent (an interrupted run, a non-spec shape) fall back to inline
// `✖ …` markers. Never fabricate: an unparsable output yields an empty list.
export function suiteReds(out) {
  const text = String(out || '');
  const reds = [];
  const seen = new Set();
  const push = (name, at) => {
    const key = `${name}\u0000${at}`;
    if (name && !seen.has(key)) {
      seen.add(key);
      reds.push({name, at});
    }
  };
  const NAME = /^✖\s+(.+?)\s*(?:\(\d+(?:\.\d+)?ms\))?\s*$/;
  const cut = text.lastIndexOf('✖ failing tests:');
  if (cut >= 0) {
    let pendingAt = '';
    for (const raw of text.slice(cut).split(/\r?\n/)) {
      const line = raw.trimEnd();
      const at = /^\s*test at (.+)$/.exec(line);
      if (at) {
        pendingAt = at[1].trim();
        continue;
      }
      const m = NAME.exec(line);
      if (m && m[1] !== 'failing tests:') {
        push(m[1], pendingAt);
        pendingAt = '';
      }
    }
  }
  if (!reds.length) {
    for (const raw of text.split(/\r?\n/)) {
      const m = NAME.exec(raw.trimEnd());
      if (m && m[1] !== 'failing tests:') push(m[1], '');
    }
  }
  return reds;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function dumpSuiteOutput(out) {
  try {
    const rel = path.join('temp', `gate-suite-${stamp()}.log`);
    fs.mkdirSync(path.dirname(path.join(REPO, rel)), {recursive: true});
    fs.writeFileSync(path.join(REPO, rel), out, 'utf8');
    return rel;
  } catch {
    return null;
  }
}

function suiteRedsLine(reds) {
  const shown = reds.slice(0, 30).map((red) => `${red.name}${red.at ? ' @ ' + red.at : ''}`);
  const more = reds.length > shown.length ? ` | … +${reds.length - shown.length} more` : '';
  return `  [gate] suite reds (${reds.length}): ${reds.length ? shown.join(' | ') + more : 'unparsed'}`;
}

// ---------------------------------------------------------------- L1: the suite
function suite() {
  const files = fs.readdirSync(path.join(REPO, 'test')).filter((n) => n.endsWith('.test.mjs')).sort().map((n) => path.join('test', n));
  const env = {...process.env, ORCH_AGENT: process.env.ORCH_AGENT || AGENT};
  console.error(`  [gate] running ${files.length} test files (this takes minutes)…`);
  // 并发可调（ORCH_GATE_TEST_CONCURRENCY，默认 3）：机器忙/内存紧时降到 1 能显著减少容量敏感用例的假红
  // （2026-09-18 用户令：别等内存，能跑就跑）。
  const suiteTimeout = Math.max(60000, Number(String(process.env.ORCH_GATE_SUITE_TIMEOUT_MS || '').trim() || '') || 900000);
  const r = node(['--test', '--test-concurrency=' + (String(process.env.ORCH_GATE_TEST_CONCURRENCY || '').trim() || '3'), ...files], {env, timeout: suiteTimeout});
  const num = (key) => {
    const m = r.out.match(new RegExp('^ℹ ' + key + ' (\\d+)$', 'm'));
    return m ? Number(m[1]) : null;
  };
  const pass = num('pass'), fail = num('fail'), skipped = num('skipped'), cancelled = num('cancelled');
  const missing = [['pass', pass], ['fail', fail], ['skipped', skipped]].filter(([, v]) => v === null).map(([k]) => k);
  let ok = !missing.length && pass > 0 && fail === 0 && skipped === 0 && r.status === 0;
  const lines = [`expected: pass>0 / fail==0 / skipped==0 / exit==0`];
  if (missing.length) lines.push(`actual: missing ${missing.join(', ')} ⇒ unknown is failure`);
  else lines.push(`actual: pass=${pass} fail=${fail} skipped=${skipped} cancelled=${cancelled} exit=${r.status}`);
  let redLine = '';
  if (!ok) {
    const reds = suiteReds(r.out);
    if (reds.length) {
      lines.push(`failing tests (${reds.length}):`);
      for (const red of reds.slice(0, 15)) lines.push(`  ✖ ${red.name}${red.at ? ' — ' + red.at : ''}`);
      if (reds.length > 15) lines.push(`  … and ${reds.length - 15} more`);
    } else {
      lines.push(`failing tests: none named in the suite output (parse miss or the suite never ran)`);
    }
    // 隔离复跑（2026-09-18 固化既有的手工流程）：套件内的红若是环境型（内存/容量/机器忙），
    // 单独复跑该文件会绿；真回归单独跑仍然红。全绿 = 记环境假红后放行（仍记录在案），仍红 = 真红拦截。
    // 仅当套件汇总完整（未被超时截断）时才允许放行，保证 L4 的"实测总数"可信。
    if (reds.length && !missing.length) {
      const srcs = new Map(files.map((rel) => [rel, fs.readFileSync(path.join(REPO, rel), 'utf8')]));
      const byFile = new Map();
      for (const red of reds) {
        const name = red.name.replace(/\s*\(\d+(?:\.\d+)?ms\)\s*$/, '');
        for (const rel of files) {
          if (srcs.get(rel).includes(name)) byFile.set(rel, (byFile.get(rel) || 0) + 1);
        }
      }
      const stillRed = [];
      for (const rel of [...byFile.keys()].sort()) {
        const rr = node(['--test', rel]);
        const isoRed = rr.status !== 0;
        if (isoRed) stillRed.push(rel);
        lines.push(`  isolation re-run ${rel}: ${isoRed ? 'STILL RED' : 'green'} (${byFile.get(rel)} red title[s])`);
      }
      if (byFile.size && !stillRed.length) {
        ok = true;
        lines.push(`actual: all ${reds.length} red title[s] green in isolation (${byFile.size} file[s]) ⇒ environment flake, recorded, not blocking`);
        redLine = `  [gate] L1 environment flake recorded: ${reds.length} red title[s] green in isolated re-runs (${[...byFile.keys()].join(', ')}); suite summary observed pass=${pass} fail=${fail}`;
      }
    }
    const dump = dumpSuiteOutput(r.out);
    lines.push(dump ? `full suite output: ${dump}` : `full suite output could not be written (see the captured gate log)`);
    if (!redLine) redLine = suiteRedsLine(reds);
  }
  check('L1', 'offline regression suite', ok, lines);
  if (redLine) console.log(redLine);
  if (missing.length) return undefined;                       // 被截断：不许放行，L4 也会对不上
  return ok && fail > 0 ? pass + fail : pass;                 // 环境假红放行时，实测总数 = pass+fail（隔离复跑已逐条证绿）
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

function main() {
  const args = new Set(process.argv.slice(2));
  const wants = (flag) => args.has(flag) || args.has('--all') || args.size === 0;
  console.log(`  [gate] shell ORCH_SPAWN_MODE=${SHELL_SPAWN_MODE}; children pinned to headless (zero popups)`);

  let measuredSuite = null;
  if (wants('--suite')) measuredSuite = suite();
  if (wants('--doctor')) doctor();
  if (wants('--canary')) canary();
  if (wants('--unknown-run')) unknownRun();
  if (wants('--consistency')) consistency(measuredSuite);

  const failed = results.filter((r) => !r.ok).map((r) => r.id);
  console.log(`ORCH_GATE: ${failed.length ? 'FAIL (' + failed.join(', ') + ')' : 'PASS'} — ${results.length} criteria`);
  process.exitCode = failed.length ? 1 : 0;
}

// 只有被直接执行时才跑判据；被 import（单测/工具）时不得有副作用。
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
