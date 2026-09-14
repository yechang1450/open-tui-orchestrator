import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {discoverModelDetection} from '../scripts/core/adapt-lib.mjs';
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
  assert.equal(hasModelDetector('claude'), true);
  assert.equal(hasModelDetector('openclaw'), false);
  assert.equal(hasModelDetector('definitely-not-profiled'), false);
});
