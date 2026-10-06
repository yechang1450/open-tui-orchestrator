import test from 'node:test';
import assert from 'node:assert/strict';
import * as safety from './live-safety.mjs';

const passingReport = () => ({
  samplingComplete: true,
  measurementFailures: [],
  engineResult: {code: 0},
  pollResult: {code: 0},
  peak: 8,
  capacity: 8,
  receiptsValid: true,
  ordered: true,
  overlap: true,
  windowLaunches: 8,
  uniqueLaunchers: 8,
  automaticClose: true,
  coreUnchanged: true,
  jsonDiagnostics: [],
  summary: {results: Object.fromEntries(Array.from({length: 8 }, (_, i) => ['B' + i, {status: 'verified'}]))},
});

test('codex final verdict rejects blocked cleanup after the live checks pass', () => {
  assert.equal(typeof safety.finalizeCodexReport, 'function');
  const report = safety.finalizeCodexReport(passingReport(), {
    status: 'blocked_by_host_policy',
    diagnostics: ['controller identity unavailable'],
  });
  assert.equal(report.passed, false);
  assert.deepEqual(report.failureReasons, ['cleanup-blocked_by_host_policy']);
});

test('codex final verdict accepts clean cleanup after the live checks pass', () => {
  const report = safety.finalizeCodexReport(passingReport(), {state: 'clean'});
  assert.equal(report.passed, true);
  assert.deepEqual(report.failureReasons, []);
});
