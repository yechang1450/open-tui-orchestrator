import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {adaptAgent, discoverModelDetection, locateCli} from '../scripts/core/adapt-lib.mjs';
import {detectHostModelEffort, hasModelDetector, readSectionKey} from '../scripts/core/host-model.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const family = path.join(root, 'temp');

// 伪 CLI：--help 里带「模型短别名 + 长旗标」形态（"-m MODEL, --model MODEL"），
// 这是会把 prompt 旗标误判成 -m 的经典形态（hermes 实测踩过）。
const FAKE_ALIAS = `import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('  -z PROMPT, --oneshot PROMPT\\n  -m MODEL, --model MODEL\\n  --reasoning LEVEL\\n  --yolo'); process.exit(0); }
if (args.includes('--version')) { console.log('FakeAlias 1.2.3'); process.exit(0); }
const prompt = args[args.length - 1] || '';
const m = /reply with exactly (ADAPTOK-\\S+) and nothing else/.exec(prompt);
if (m) { console.log(m[1]); process.exit(0); }
console.log('done __ORCH_DONE__');
`;

test('adapt never mistakes a model short alias (-m) for the prompt flag', () => {
  fs.mkdirSync(family, {recursive: true});
  const dir = fs.mkdtempSync(path.join(family, 'adapt-alias-'));
  try {
    const fake = path.join(dir, 'fakealias.mjs');
    fs.writeFileSync(fake, FAKE_ALIAS);
    const cleanEnv = {...process.env};
    for (const k of ['ORCH_AGENT', 'ORCH_CLI', 'ORCH_MODEL', 'ORCH_EFFORT']) delete cleanEnv[k];
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'adapt.mjs'), '--agent', 'fakealias', '--cli', fake, '--profiles-dir', path.join(dir, 'profiles'), '--no-commit', '--json'], {env: cleanEnv, encoding: 'utf8', windowsHide: true, timeout: 120000});
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const report = JSON.parse(r.stdout);
    assert.equal(report.passed, true, JSON.stringify(report).slice(0, 400));
    assert.deepEqual(report.profile.args.prompt, ['-z'], 'the prompt flag must not be the model short alias');
    assert.deepEqual(report.profile.args.model, ['--model']);
    assert.deepEqual(report.profile.args.effort, ['--reasoning']);
    assert.deepEqual(report.profile.args.approve, ['--yolo']);
    assert.equal(report.live.answered, true);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

// 伪 CLI：--help 只暴露模型短别名（"-m MODEL, --model MODEL"），没有任何 prompt 旗标。
// 没有 `f !== modelAlias` 守卫时，-m（PROMPT_FLAG_CANDIDATES 末位）会被当作 prompt 旗标采纳——
// prompt 喂给 model 参数、CLI 掉进交互模式。上面那个夹具同时含 -z，删掉守卫仍绿，覆盖不到这一点。
const FAKE_M_ONLY = `import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('  -m MODEL, --model MODEL\\n  --reasoning LEVEL\\n  --yolo'); process.exit(0); }
if (args.includes('--version')) { console.log('FakeMOnly 1.2.3'); process.exit(0); }
console.log('done __ORCH_DONE__');
`;

test('adapt rejects a CLI whose only short flag is the model alias (no prompt flag present)', () => {
  fs.mkdirSync(family, {recursive: true});
  const dir = fs.mkdtempSync(path.join(family, 'adapt-monly-'));
  try {
    const fake = path.join(dir, 'fakemonly.mjs');
    fs.writeFileSync(fake, FAKE_M_ONLY);
    const cleanEnv = {...process.env};
    for (const k of ['ORCH_AGENT', 'ORCH_CLI', 'ORCH_MODEL', 'ORCH_EFFORT']) delete cleanEnv[k];
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'adapt.mjs'), '--agent', 'fakemonly', '--cli', fake, '--profiles-dir', path.join(dir, 'profiles'), '--no-commit', '--json'], {env: cleanEnv, encoding: 'utf8', windowsHide: true, timeout: 120000});
    assert.equal(r.status, 1, 'a rejected candidate must exit non-zero: ' + (r.stderr || r.stdout));
    const report = JSON.parse(r.stdout);
    assert.equal(report.passed, false, JSON.stringify(report).slice(0, 400));
    assert.match(String(report.reason || ''), /no one-shot prompt flag/, 'the model alias must not be adopted as the prompt flag: ' + JSON.stringify(report.reason));
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('modelDetection discovers $VAR-home + sectioned configs (hermes-shaped)', () => {
  fs.mkdirSync(family, {recursive: true});
  const home = fs.mkdtempSync(path.join(family, 'adapt-home-'));
  try {
    fs.writeFileSync(path.join(home, 'config.yaml'), ['model:', '  default: fake/model-y', '  provider: p1', 'agent:', '  reasoning_effort: high', ''].join('\n'));
    const spec = discoverModelDetection('fakehome', {home: '', env: {...process.env, FAKEHOME_HOME: home}});
    assert.ok(spec && spec.config && spec.config.length === 1, JSON.stringify(spec));
    assert.equal(spec.config[0].file, '$FAKEHOME_HOME/config.yaml');
    assert.equal(spec.config[0].section, 'model');
    assert.equal(spec.config[0].modelKey, 'default');
    assert.equal(spec.config[0].effortKey, 'reasoning_effort');
    assert.equal(spec.config[0].effortSection, 'agent');

    // 引擎消费：$VAR 展开 + 分节读取 → model/effort 跟随发起者
    const profiles = path.join(home, 'profiles');
    fs.mkdirSync(profiles, {recursive: true});
    fs.writeFileSync(path.join(profiles, 'fakehome.json'), JSON.stringify({
      schema: 1, id: 'fakehome', label: 'fakehome', bin: ['fakehome.exe'], helpFlags: ['-z'],
      versionPattern: '(\\d+\\.\\d+\\.\\d+)', args: {approve: [], extra: [], model: ['--model'], effort: ['--reasoning'], prompt: ['-z']},
      modelDetection: spec,
    }));
    const env = {...process.env, ORCH_AGENT_PROFILES_DIR: profiles, FAKEHOME_HOME: home};
    const d = detectHostModelEffort('fakehome', {env});
    assert.equal(d.model, 'fake/model-y');
    assert.equal(d.effort, 'high');
    assert.equal(d.source, 'profile:fakehome');
    assert.equal(hasModelDetector('fakehome', env), true);

    // $VAR 未定义：优雅跳过（null），不抛错、不误读
    const envNoHome = {...process.env, ORCH_AGENT_PROFILES_DIR: profiles};
    delete envNoHome.FAKEHOME_HOME;
    assert.equal(detectHostModelEffort('fakehome', {env: envNoHome}), null);
  } finally { fs.rmSync(home, {recursive: true, force: true}); }
});

test('readSectionKey reads nested keys only within the exact section', () => {
  fs.mkdirSync(family, {recursive: true});
  const dir = fs.mkdtempSync(path.join(family, 'section-key-'));
  try {
    const y = path.join(dir, 'a.yaml');
    fs.writeFileSync(y, ['model:', '  default: m1', '  reasoning_effort: low', 'agent:', '  reasoning_effort: high', 'other:', '  default: nope', ''].join('\n'));
    assert.equal(readSectionKey(y, 'model', 'default'), 'm1');
    assert.equal(readSectionKey(y, 'model', 'reasoning_effort'), 'low');
    assert.equal(readSectionKey(y, 'agent', 'reasoning_effort'), 'high');
    assert.equal(readSectionKey(y, 'other', 'default'), 'nope');
    assert.equal(readSectionKey(y, 'missing', 'default'), '');
    const j = path.join(dir, 'b.json');
    fs.writeFileSync(j, JSON.stringify({model: {default: 'jm'}, agent: {reasoning_effort: 'mid'}}));
    assert.equal(readSectionKey(j, 'model', 'default'), 'jm');
    assert.equal(readSectionKey(j, 'agent', 'reasoning_effort'), 'mid');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('hasModelDetector: native adapters and detection-capable profiles only', () => {
  assert.equal(hasModelDetector('codex'), true);
  assert.equal(hasModelDetector('kimi'), true);
  assert.equal(hasModelDetector('pi'), true);
  assert.equal(hasModelDetector('opencode'), true);
  assert.equal(hasModelDetector('definitely-not-profiled'), false);
});

test('adapt rolls back the generated profile when block smoke setup throws', async () => {
  fs.mkdirSync(family, {recursive: true});
  const dir = fs.mkdtempSync(path.join(family, 'adapt-smoke-rollback-'));
  const brokenTemp = path.join(dir, 'not-a-directory');
  const profiles = path.join(dir, 'profiles');
  const fake = path.join(dir, 'fakealias.mjs');
  const profileFile = path.join(profiles, 'smokerollback.json');
  const previous = {TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR};
  try {
    fs.writeFileSync(fake, FAKE_ALIAS);
    fs.writeFileSync(brokenTemp, 'not a directory');
    process.env.TEMP = brokenTemp;
    process.env.TMP = brokenTemp;
    process.env.TMPDIR = brokenTemp;
    const report = await adaptAgent({
      id: 'smokerollback',
      cli: fake,
      env: {...process.env, ORCH_AGENT_PROFILES_DIR: profiles},
      live: false,
      smoke: true,
      commit: false,
      writeProfile: true,
    });
    assert.equal(report.passed, false, JSON.stringify(report));
    assert.match(report.reason, /not a directory|ENOTDIR|ENOENT/i);
    assert.equal(fs.existsSync(profileFile), false, 'failed smoke setup must roll back the generated profile');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('adapt returns a failure and removes a partially written initial profile', async () => {
  fs.mkdirSync(family, {recursive: true});
  const dir = fs.mkdtempSync(path.join(family, 'adapt-initial-write-rollback-'));
  const profiles = path.join(dir, 'profiles');
  const fake = path.join(dir, 'fakealias.mjs');
  const profileFile = path.join(profiles, 'initialwritefailure.json');
  const originalWrite = fs.writeFileSync;
  let injected = false;
  try {
    fs.writeFileSync(fake, FAKE_ALIAS);
    fs.writeFileSync = (file, data, ...args) => {
      if (!injected && path.resolve(String(file)) === path.resolve(profileFile)) {
        injected = true;
        originalWrite(file, '{"partial":', ...args);
        throw new Error('injected profile write failure');
      }
      return originalWrite(file, data, ...args);
    };
    const report = await adaptAgent({
      id: 'initialwritefailure',
      cli: fake,
      env: {...process.env, ORCH_AGENT_PROFILES_DIR: profiles},
      live: false,
      smoke: false,
      commit: false,
      writeProfile: true,
    });
    assert.equal(report.passed, false, JSON.stringify(report));
    assert.match(String(report.reason || ''), /injected profile write failure/);
    assert.equal(fs.existsSync(profileFile), false, 'the failed initial write must leave no profile behind');
  } finally {
    fs.writeFileSync = originalWrite;
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

// 子命令型 CLI（2026-10-11）：顶层 --help 不提一次性提示旗标、旗标只在子命令帮助里
// （opencode 型 `run --help`）——旧行为误判「非 print-class」。新行为：二级探测命中子命令，
// 旗标知识取自该子命令帮助，子命令落画像 args.subcommand（进一次性调用的 argv 最前）。
const FAKE_SUB = `import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('FakeSub 2.5.0'); process.exit(0); }
if (args.includes('run') && args.includes('--help')) { console.log('  -p PROMPT\\n  --auto'); process.exit(0); }
if (args.includes('--help')) { console.log('usage: fake subcommands: run'); process.exit(0); }
const prompt = args[args.length - 1] || '';
const m = /reply with exactly (ADAPTOK-\\S+) and nothing else/.exec(prompt);
if (m) { console.log(m[1]); process.exit(0); }
console.log('done __ORCH_DONE__');
`;
test('adapt probes subcommand help when the top-level surface lacks the prompt flag', () => {
  fs.mkdirSync(family, {recursive: true});
  const dir = fs.mkdtempSync(path.join(family, 'adapt-sub-'));
  try {
    const fake = path.join(dir, 'fakesub.mjs');
    fs.writeFileSync(fake, FAKE_SUB);
    const cleanEnv = {...process.env};
    for (const k of ['ORCH_AGENT', 'ORCH_CLI', 'ORCH_MODEL', 'ORCH_EFFORT']) delete cleanEnv[k];
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'adapt.mjs'), '--agent', 'fakesub', '--cli', fake, '--profiles-dir', path.join(dir, 'profiles'), '--no-commit', '--json'], {env: cleanEnv, encoding: 'utf8', windowsHide: true, timeout: 120000});
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const report = JSON.parse(r.stdout);
    assert.equal(report.passed, true, JSON.stringify(report).slice(0, 400));
    assert.equal(report.subcommand, 'run');
    assert.deepEqual(report.profile.args.subcommand, ['run']);
    assert.deepEqual(report.profile.args.prompt, ['-p']);
    assert.equal(report.live.answered, true);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

// npm shim 解析（2026-10-11）：.cmd 包装器文本里的 node_modules 真入口被自动解析——通用形态、
// 不写死任何包名；解析不到仍走旧行为（回报 shim、请用户指 --cli）。红例：旧 locateCli 对 shim
// 一律回 { shim }，adapt 即报「only a shell shim found」。
test('locateCli resolves an npm shim to its real node entry (no per-package hardcoding)', () => {
  fs.mkdirSync(family, {recursive: true});
  const dir = fs.mkdtempSync(path.join(family, 'adapt-shim-'));
  try {
    const entry = path.join(dir, 'node_modules', '@scope', 'fakepkg', 'bin', 'fake.js');
    fs.mkdirSync(path.dirname(entry), {recursive: true});
    fs.writeFileSync(entry, 'console.log("ok");\n', 'utf8');
    const shim = path.join(dir, 'fakeshim.cmd');
    fs.writeFileSync(shim, '@ECHO off\r\nnode "%~dp0\\node_modules\\@scope\\fakepkg\\bin\\fake.js" %*\r\n', 'utf8');
    const located = locateCli('fakeshim', {PATH: dir}, undefined);
    assert.ok(located.bin, 'the shim must resolve to a real entry: ' + JSON.stringify(located));
    assert.deepEqual(located.prefixArgs, [entry]);
    assert.equal(located.source, entry);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('locateCli keeps the old shim verdict when the wrapper has no resolvable entry', () => {
  fs.mkdirSync(family, {recursive: true});
  const dir = fs.mkdtempSync(path.join(family, 'adapt-shim-fallback-'));
  try {
    const shim = path.join(dir, 'lonely.cmd');
    fs.writeFileSync(shim, '@ECHO off\r\nrem nothing here\r\n', 'utf8');
    const located = locateCli('lonely', {PATH: dir}, undefined);
    assert.equal(located.shim, shim, 'an unresolvable shim must keep the legacy verdict');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('locateCli never resolves where.exe through the process cwd (anchored to SystemRoot)', {skip: process.platform !== 'win32'}, () => {
  fs.mkdirSync(family, {recursive: true});
  const dir = fs.mkdtempSync(path.join(family, 'locate-anchor-'));
  const prevCwd = process.cwd();
  try {
    // 劫持件：进程 cwd 里放一个伪 where.exe（= node 本体拷贝）。裸名解析会先命中 cwd，
    // 它一被执行就会写下标记文件——SystemRoot 锚定后的实现必须完全绕开它。
    fs.copyFileSync(process.execPath, path.join(dir, 'where.exe'));
    const marker = path.join(dir, 'called.txt');
    const script = path.join(dir, 'marker.mjs');
    fs.writeFileSync(script, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'called');\nconsole.log('C:/fake/hit.exe');\n`, 'utf8');
    process.chdir(dir);
    const located = locateCli(script, {...process.env});
    assert.equal(fs.existsSync(marker), false, 'the cwd hijack must not run; where.exe must stay SystemRoot-anchored');
    assert.ok(located, 'resolution must return a verdict');
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
