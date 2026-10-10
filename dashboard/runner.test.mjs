import test from 'node:test';
import assert from 'node:assert/strict';
import { requireAutoscaler } from './runner.mjs';

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
