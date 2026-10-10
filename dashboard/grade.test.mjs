import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeAutoscale, gradeConnections, gradePrometheus, gradeTimeout, gradeShutdown, gradeRollout, gradeStream } from './grade.mjs';
import { classifyResult } from './status.mjs';

test('connection verifier distinguishes reuse from new sockets', () => {
  assert.equal(gradeConnections(Array(8).fill('1'), ['1','2','3','4','5','6','7','8']).status, 'pass');
  assert.equal(gradeConnections(Array(8).fill('1'), Array(8).fill('1')).status, 'fail');
});
test('shutdown verifier requires a targeted, completed long request', () => {
  const samples = Array.from({ length: 25 }, () => ({ ok: true }));
  assert.equal(gradeShutdown({ slow: { pod: 'p1', complete: true }, deletedPod: 'p1', samples, mode: 'graceful' }).status, 'pass');
  assert.equal(gradeShutdown({ slow: { pod: 'p1', complete: false }, deletedPod: 'p1', samples, mode: 'graceful' }).status, 'fail');
  assert.equal(gradeShutdown({ slow: { pod: 'p1', complete: true }, deletedPod: 'p2', samples, mode: 'graceful' }).status, 'inconclusive');
});
test('rollout verifier checks replacement and request failures', () => {
  const samples = Array.from({ length: 25 }, () => ({ ok: true }));
  assert.equal(gradeRollout(samples, ['old'], ['new']).status, 'pass');
  assert.equal(gradeRollout(samples, ['old'], ['old']).status, 'inconclusive');
  assert.equal(gradeRollout([...samples, { ok: false }], ['old'], ['new']).status, 'fail');
});
test('idle timeout verifier distinguishes client and upstream pools', () => {
  const a = { ok: true, pod: 'p1', edgeConnection: '1', appConnection: '1' };
  const b = { ok: true, pod: 'p1', edgeConnection: '1', appConnection: '2' };
  assert.equal(gradeTimeout([a, a], [a, b]).status, 'pass');
  assert.equal(gradeTimeout([a, a], [a, a]).status, 'fail');
});
test('stream verifier requires a complete 20-tick response', () => {
  assert.equal(gradeStream({ stream: { pod: 'p1', complete: true, body: Array(20).fill('tick').join('\n') }, deletedPod: 'p1' }).status, 'pass');
  assert.equal(gradeStream({ stream: { pod: 'p1', complete: false, body: 'tick' }, deletedPod: 'p1' }).status, 'fail');
});

const okLoad = (n, ok = true) => Array.from({ length: n }, () => ({ ok }));

test('autoscale grader passes a real scale-out and scale-in with clean drain', () => {
  const r = gradeAutoscale({ initial: 2, peak: 4, final: 2, stableDown: true, samples: okLoad(50), drainSamples: okLoad(20) });
  assert.equal(r.status, 'pass');
  assert.ok(r.checks.every((c) => c.pass));
  assert.equal(r.evidence.loadRequests, 50);
  assert.equal(r.evidence.loadFailures, 0);
  assert.equal(r.evidence.drainRequests, 20);
});

test('autoscale grader records actual load failures instead of zero', () => {
  const samples = [...okLoad(48), { ok: false }, { ok: false }];
  const r = gradeAutoscale({ initial: 2, peak: 4, final: 2, stableDown: true, samples, drainSamples: okLoad(20) });
  assert.equal(r.evidence.loadRequests, 50);
  assert.equal(r.evidence.loadFailures, 2);
});

test('autoscale scale-down flag alone cannot pass when final differs from initial', () => {
  const r = gradeAutoscale({ initial: 2, peak: 4, final: 3, stableDown: true, samples: okLoad(50), drainSamples: okLoad(20) });
  assert.notEqual(r.status, 'pass');
  assert.equal(r.checks[1].pass, false);
});

test('autoscale routes each criterion failure to non-pass', () => {
  assert.equal(gradeAutoscale({ initial: 2, peak: 2, final: 2, stableDown: true, samples: okLoad(50), drainSamples: okLoad(20) }).status, 'fail');
  assert.equal(gradeAutoscale({ initial: 2, peak: 4, final: 4, stableDown: false, samples: okLoad(50), drainSamples: okLoad(20) }).status, 'fail');
  const dirty = [...okLoad(19), { ok: false }];
  assert.equal(gradeAutoscale({ initial: 2, peak: 4, final: 2, stableDown: true, samples: okLoad(50), drainSamples: dirty }).status, 'fail');
});

test('autoscale with no observations is inconclusive, not a pass', () => {
  const r = gradeAutoscale({ initial: 2, peak: 2, final: 2, stableDown: false, samples: [], drainSamples: [] });
  assert.equal(r.status, 'inconclusive');
});

test('prometheus grader passes a real scrape, scale-out, and scale-in', () => {
  const r = gradePrometheus({ scrapeTargets: 2, peakRps: 12.5, peak: 4, initial: 2, final: 2, stableDown: true, load: okLoad(100), drain: okLoad(20), query: 'q', thresholdRpsPerPod: 5 });
  assert.equal(r.status, 'pass');
  assert.equal(r.evidence.loadRequests, 100);
  assert.equal(r.evidence.peakRps, 12.5);
});

test('prometheus routes each criterion failure to non-pass', () => {
  const base = { scrapeTargets: 2, peakRps: 12.5, peak: 4, initial: 2, final: 2, stableDown: true, load: okLoad(100), drain: okLoad(20), query: 'q' };
  assert.equal(gradePrometheus({ ...base, scrapeTargets: 1 }).status, 'fail');
  assert.equal(gradePrometheus({ ...base, peakRps: 2 }).status, 'fail');
  assert.equal(gradePrometheus({ ...base, peak: 2 }).status, 'fail');
  assert.equal(gradePrometheus({ ...base, final: 3, stableDown: true }).status, 'fail');
  assert.equal(gradePrometheus({ ...base, drain: [...okLoad(19), { ok: false }] }).status, 'fail');
});

test('prometheus with no observations is inconclusive, not a pass', () => {
  const r = gradePrometheus({ scrapeTargets: 0, peakRps: 0, peak: 2, initial: 2, final: 2, stableDown: false, load: [], drain: [], query: 'q' });
  assert.equal(r.status, 'inconclusive');
});

test('abrupt shutdown pass is still an observed transport error in metrics', () => {
  const slow = { pod: 'p1', complete: false, error: 'ECONNRESET' };
  const samples = okLoad(25);
  assert.equal(gradeShutdown({ slow, samples, deletedPod: 'p1', mode: 'abrupt' }).status, 'pass');
  assert.equal(classifyResult(slow).kind, 'transport');
});
