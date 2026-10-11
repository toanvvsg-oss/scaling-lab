import test from 'node:test';
import assert from 'node:assert/strict';
import { requireAutoscaler, startRequest } from './runner.mjs';
import http from 'node:http';

const cpu = { hpa: { name: 'app', metrics: [{ type: 'Resource', resource: 'cpu' }] } };
const prometheus = { hpa: { name: 'keda-hpa-app-prometheus', metrics: [{ type: 'External' }] } };

test('CPU lesson only accepts the CPU resource HPA', () => {
  assert.doesNotThrow(() => requireAutoscaler(cpu, 'cpu'));
  assert.throws(() => requireAutoscaler(prometheus, 'cpu'), /make hpa-up/);
  assert.throws(() => requireAutoscaler({ hpa: null }, 'cpu'), /make hpa-up/);
});

test('Prometheus lesson only accepts its KEDA external metric HPA', () => {
  assert.doesNotThrow(() => requireAutoscaler(prometheus, 'prometheus'));
  assert.throws(() => requireAutoscaler(cpu, 'prometheus'), /make prometheus-up/);
  assert.throws(() => requireAutoscaler({ hpa: null }, 'prometheus'), /make prometheus-up/);
});

test('interrupted response retains its received 200 status and request identity', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'x-request-id': 'interrupted-request', 'x-pod': 'draining-pod' });
    res.write('partial body');
    setTimeout(() => res.destroy(), 30);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const request = startRequest('/slow', false, `http://127.0.0.1:${server.address().port}`);
  assert.equal((await request.headers).status, 200);
  const outcome = await request.done;
  assert.equal(outcome.status, 200);
  assert.equal(outcome.complete, false);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.requestId, 'interrupted-request');
  assert.equal(outcome.pod, 'draining-pod');
  assert.equal(outcome.error, 'ECONNRESET');
});
