import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeConnections, gradeTimeout, gradeShutdown, gradeRollout, gradeStream } from './grade.mjs';

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
