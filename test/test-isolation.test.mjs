import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// 判据（2026-09-22）：凡是删掉 NODE_TEST_CONTEXT 去走真实入口的地方，都必须显式钉住
// ORCH_COORDINATOR_DIR（协调器 = 全局窗口槽位租约 + 内核互斥的所在）。
// 现场：caller-driven / queue-backoff / print-profile / orch-force（以及 adapt --smoke）都走真实入口，
// 不钉住就落到机器级 HKCU 定位器，于是并发跑的几个测试文件共用同一个槽位池、互相抢容量，直到把本 run
// 的 120s 预算耗光（实测：两条任务都 timeout，reason=capacity，整条用例 122s 假红）；定位器还会被钉在
// 一个随后被删掉的临时工作区上（本机实勘：HKCU\Software\TuiOrchestrator\CoordinatorRoot 指向
// <repo>\temp\caller-run-xBFpS2\temp\orchestrator\coordinator，该目录早已不存在）。
// 红例（必红）：删掉任意一处 ORCH_COORDINATOR_DIR ⇒ 本判据点名该文件。
test('every entry that drops the test marker pins a workspace-local coordinator', () => {
  const walkMjs = (dir) => fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'temp') return [];
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkMjs(abs);
    return entry.name.endsWith('.mjs') ? [abs] : [];
  });
  const rels = [...walkMjs(path.join(root, 'test')), ...walkMjs(path.join(root, 'scripts'))]
    .map((abs) => path.relative(root, abs))
    .filter((rel) => rel !== 'test/test-isolation.test.mjs');
  const required = ['scripts/core/adapt-lib.mjs'];
  assert.deepEqual(required.filter((rel) => !fs.existsSync(path.join(root, rel))), [],
    'explicit real-entry coverage disappeared: ' + required.join(', '));
  const offenders = [];
  for (const rel of rels) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const pinsCoordinator=/(?:ORCH_COORDINATOR_DIR\s*[:=]|process\.env\.ORCH_COORDINATOR_DIR)/.test(text);
    const dropsMarker=/(?:delete[^\n;]*NODE_TEST_CONTEXT|NODE_TEST_CONTEXT[^\n;]*delete)/.test(text);
    if (dropsMarker && !pinsCoordinator) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'these entries run the real machine-wide coordinator path: ' + offenders.join(', '));
});
