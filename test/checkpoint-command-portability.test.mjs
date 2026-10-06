// checkpoint 命令载体的跨 shell 可移植性判据。
//
// 背景（2026-10-01 实测）：runner.mjs 曾把检查点命令拼成
//     node "C:\...\checkpoint.mjs" "C:\...\attempt.json" T001 started
// 交付给宿主。该形态在两种真实宿主上都失败：
//   ① cmd.exe：引号被并进路径 ⇒ Cannot find module '...\"C:\...checkpoint.mjs\"'
//   ② Git Bash 宿主（kimi）：陷入 MSYS↔cmd 多层转义的自我推演，整整一轮不执行
// 修法：为每个 attempt 预生成路径写死的 checkpoint.cmd，prompt 只下发单一令牌。
//
// 本判据同时覆盖「红的旧形态」与「绿的新形态」，避免只锁一侧。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {escapeCmdBatchPath} from '../scripts/core/runner.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkpoint = path.join(repo, 'scripts', 'core', 'checkpoint.mjs');

function findBash() {
  const configured = String(process.env.BASH_PATH || '').trim();
  if (configured && fs.existsSync(configured)) return configured;
  const whereExe = path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'where.exe');
  const result = spawnSync(whereExe, ['bash.exe'], {encoding: 'utf8', windowsHide: true});
  return String(result.stdout || '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cp-port-'));
}

test('red: the legacy argv form is not shell-portable under cmd.exe', () => {
  const dir = tmpdir();
  try {
    const attempt = path.join(dir, 'attempt.json');
    fs.writeFileSync(attempt, JSON.stringify({runId: 'r', token: 'r-B1-a1-x', taskIds: ['T001']}));

    // 旧形态：node "abs" "abs" <id> <state>，整行交给 cmd —— 引号会进路径
    const line = `node "${checkpoint}" "${attempt}" T001 started`;
    const r = spawnSync('cmd.exe', ['/d', '/s', '/c', line], {encoding: 'utf8', windowsHide: true});
    const out = `${r.stdout || ''}${r.stderr || ''}`;

    assert.notEqual(r.status, 0, 'legacy form must not silently succeed under cmd.exe');
    assert.match(out, /Cannot find module|MODULE_NOT_FOUND|SyntaxError/i,
      'legacy form is expected to fail with a module-resolution error');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('green: the .cmd carrier works when run directly', () => {
  const dir = tmpdir();
  try {
    const attempt = path.join(dir, 'attempt.json');
    fs.writeFileSync(attempt, JSON.stringify({runId: 'r', token: 'r-B1-a1-x', taskIds: ['T001']}));
    const carrier = path.join(dir, 'checkpoint.cmd');
    fs.writeFileSync(carrier,
      '@echo off\r\n' +
      `node "${checkpoint}" "${attempt}" %1 %2\r\n` +
      'exit /b %errorlevel%\r\n', 'utf8');

    const r = spawnSync(carrier, ['T001', 'started'], {encoding: 'utf8', windowsHide: true, shell: true});
    assert.equal(r.status, 0, `carrier failed: ${r.stdout || ''}${r.stderr || ''}`);

    const cp = JSON.parse(fs.readFileSync(path.join(dir, 'checkpoints', 'T001.json'), 'utf8'));
    assert.equal(cp.id, 'T001');
    assert.equal(cp.state, 'started');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('green: the .cmd carrier works when the host executes it directly', {skip: !findBash()}, () => {
  const dir = tmpdir();
  try {
    const attempt = path.join(dir, 'attempt.json');
    fs.writeFileSync(attempt, JSON.stringify({runId: 'r', token: 'r-B2-a1-x', taskIds: ['T002']}));
    const carrier = path.join(dir, 'checkpoint.cmd');
    fs.writeFileSync(carrier,
      '@echo off\r\n' +
      `node "${checkpoint}" "${attempt}" %1 %2\r\n` +
      'exit /b %errorlevel%\r\n', 'utf8');

    // 宿主真实形态：Git Bash 直调这一行（A 臂实测 rc=0）。
    // 三条已验证的坑，都写在这里以免后人重踩：
    //  ① `cmd //c` 会把含斜杠的路径二次解析、从中间截断（'p-probe2' is not recognized）；
    //  ② Node 在 Windows 上 `shell:true` 走的同样是 cmd.exe，踩同一个坑；
    //  ③ `bash -lc` 会加载 login profile 并可能改动 PATH/cwd —— 用 `-c` 即可。
    //
    // 业务顺序（checkpoint.mjs 的硬校验）：started 之后必须先真的做出产物，才允许记 completed，
    // 否则报 "Record started before executing a task"。这里如实模拟那个顺序。
    const bash = findBash();

    const r1 = spawnSync(bash, ['-c', `"${carrier}" T002 started`], {encoding: 'utf8', windowsHide: true});
    assert.equal(r1.status, 0, `carrier started failed: ${r1.stdout || ''}${r1.stderr || ''}`);

    fs.writeFileSync(path.join(dir, 't002.out'), 'BETA-456');   // 真产物

    const r = spawnSync(bash, ['-c', `"${carrier}" T002 completed`], {encoding: 'utf8', windowsHide: true});
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    assert.equal(r.status, 0, `carrier failed (status=${r.status}): ${out}`);

    const cp = JSON.parse(fs.readFileSync(path.join(dir, 'checkpoints', 'T002.json'), 'utf8'));
    assert.equal(cp.state, 'completed');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('green: PowerShell invokes a .cmd carrier with spaces through the call operator', () => {
  const dir = tmpdir();
  try {
    const spaced = path.join(dir, 'attempt with spaces');
    fs.mkdirSync(spaced);
    const attempt = path.join(spaced, 'attempt.json');
    fs.writeFileSync(attempt, JSON.stringify({runId: 'r', token: 'r-B1-a1-ps', taskIds: ['T001']}));
    const carrier = path.join(spaced, 'checkpoint.cmd');
    fs.writeFileSync(carrier, '@echo off\r\n' +
      `node "${checkpoint}" "${attempt}" %1 %2\r\n` +
      'exit /b %errorlevel%\r\n', 'utf8');
    const script = path.join(dir, 'invoke.ps1');
    const quoted = carrier.replaceAll("'", "''");
    fs.writeFileSync(script, `& '${quoted}' T001 started\r\nexit $LASTEXITCODE\r\n`, 'utf8');
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-File', script], {encoding: 'utf8', windowsHide: true, timeout: 30000});
    assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
    const cp = JSON.parse(fs.readFileSync(path.join(spaced, 'checkpoints', 'T001.json'), 'utf8'));
    assert.equal(cp.id, 'T001');
    assert.equal(cp.state, 'started');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('runner guidance preserves the host shell and permits the PowerShell call operator', () => {
  const src = fs.readFileSync(path.join(repo, 'scripts', 'core', 'runner.mjs'), 'utf8');
  assert.match(src, /PowerShell[^\n]+&/, 'the prompt must document PowerShell invocation instead of forcing a cmd.exe shell');
  assert.doesNotMatch(src, /不要换成 PowerShell 语法/, 'the prompt must not forbid the host default shell that executed earlier runs successfully');
});

test('runner.mjs emits the .cmd carrier, not the legacy argv form', () => {
  const src = fs.readFileSync(path.join(repo, 'scripts', 'core', 'runner.mjs'), 'utf8');
  assert.match(src, /checkpoint\.cmd/, 'runner must generate a checkpoint.cmd carrier');
  // 载体以单一令牌下发：路径写死在 .cmd 内，外层不得再套 call 或 node-argv 形态。
  // 实测：`call "<carrier>" id state` 会让 cmd 把引号并进命令名 ⇒ '"C:\...checkpoint.cmd"' is not recognized。
  assert.match(src, /const command=\(id,state\)=>`"\$\{cpCmdFile\}" \$\{id\} \$\{state\}`/,
    'runner must hand the carrier as a bare quoted path plus id/state');
  assert.doesNotMatch(src, /call "\$\{cpCmdFile\}"/,
    'the carrier must not be wrapped in call (cmd then treats the quotes as part of the command name)');
  assert.doesNotMatch(src, /const command=\(id,state\)=>`node "\$\{helper\}"/,
    'the legacy node-argv command builder must be gone');
});

test('green: the .cmd carrier preserves percent sequences in embedded paths', {skip: process.platform !== 'win32'}, () => {
  const dir = tmpdir();
  try {
    const percentDir = path.join(dir, 'my%20project^segment');
    fs.mkdirSync(percentDir);
    const attempt = path.join(percentDir, 'attempt.json');
    fs.writeFileSync(attempt, JSON.stringify({runId: 'r', token: 'r-P-a1-x', taskIds: ['T001']}));
    const carrier = path.join(percentDir, 'checkpoint.cmd');
    fs.writeFileSync(carrier,
      '@echo off\r\n' +
      `node "${escapeCmdBatchPath(checkpoint)}" "${escapeCmdBatchPath(attempt)}" %1 %2\r\n` +
      'exit /b %errorlevel%\r\n', 'utf8');
    const script = path.join(dir, 'invoke-percent.ps1');
    const quoted = carrier.replaceAll("'", "''");
    fs.writeFileSync(script, `& '${quoted}' T001 started\r\nexit $LASTEXITCODE\r\n`, 'utf8');
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-File', script], {encoding: 'utf8', windowsHide: true, timeout: 30000});
    assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
    const cp = JSON.parse(fs.readFileSync(path.join(percentDir, 'checkpoints', 'T001.json'), 'utf8'));
    assert.equal(cp.state, 'started');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
