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
  const rels = [
    ...fs.readdirSync(path.join(root, 'test')).filter((n) => n.endsWith('.test.mjs')).map((n) => path.join('test', n)),
    path.join('scripts', 'core', 'adapt-lib.mjs'),
  ];
  const offenders = [];
  for (const rel of rels) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    if (/delete[^\n;]{0,40}NODE_TEST_CONTEXT/.test(text) && !text.includes('ORCH_COORDINATOR_DIR')) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'these entries run the real machine-wide coordinator path: ' + offenders.join(', '));
});
