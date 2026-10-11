import test from 'node:test';
import assert from 'node:assert/strict';
import { clientOutcomes } from './client-outcomes.mjs';

test('200 headers followed by a reset are interrupted, not successful or HTTP 500', () => {
  const stats = clientOutcomes([
    { type: 'slow-start', data: { requestId: 'r1', status: 200, pod: 'app-one' } },
    { type: 'slow-end', data: { requestId: 'r1', complete: false, error: 'ECONNRESET' } },
    { type: 'sample', data: { requestId: 'r2', ok: true, status: 200 } },
    { type: 'request', data: { requestId: 'r3', ok: false, status: 502, complete: true } },
    { type: 'request', data: { ok: false, error: 'ECONNREFUSED' } },
  ]);
  assert.equal(stats.total, 4);
  assert.equal(stats.ok2xx, 1);
  assert.equal(stats.http5xx, 1);
  assert.equal(stats.interrupted, 1);
  assert.equal(stats.transport, 1);
  assert.equal(stats.failed, 3);
  assert.equal(stats.recentErrors.find((e) => e.error === 'ECONNRESET').status, 200);
});

test('request starts and lifecycle events are excluded; duplicate terminal events count once', () => {
  const stats = clientOutcomes([
    { type: 'stream-start', data: { requestId: 'r1', status: 200 } },
    { type: 'app-signal', data: { active: 1 } },
    { type: 'stream-end', data: { requestId: 'r1', status: 200, complete: true } },
    { type: 'sample', data: { requestId: 'r1', status: 200, ok: true } },
    { type: 'slow-start', data: { requestId: 'pending', status: 200 } },
  ]);
  assert.equal(stats.total, 1);
  assert.equal(stats.completed, 1);
  assert.equal(stats.ok2xx, 1);
  assert.equal(stats.failed, 0);
  assert.equal(clientOutcomes().total, 0);
});
