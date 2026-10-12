import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runs, archives, createRun, cleanupRun, describeRun, validateRunId, MAX_ACTIVE_RUNS, activeRuns, parseHpa,
} from './runs.mjs';

import { makeFakeCluster } from './test-fake.mjs';

function quiet() {
  return () => {};
}

test('creation returns the allocated id and correlates registry entries', async () => {
  runs.clear(); archives.clear();
  const fake = makeFakeCluster();
  const a = await createRun('prometheus', quiet(), fake.deps);
  const b = await createRun('autoscale', quiet(), fake.deps);
  assert.notEqual(a.id, b.id);
  assert.equal(a.ns, `scaling-run-${a.id}`);
  assert.ok(runs.has(a.id) && runs.has(b.id));
  assert.equal(a.status, 'ready');
  const labels = fake.namespaces.get(a.ns).labels;
  assert.equal(labels['scaling.lab/run'], a.id);
  for (let i = 2; i < MAX_ACTIVE_RUNS; i++) await createRun('connections', quiet(), fake.deps);
  await assert.rejects(createRun('prometheus', quiet(), fake.deps), /Run limit reached/);
  assert.equal(fake.namespaces.size, 7);
  assert.equal(MAX_ACTIVE_RUNS, 7);
});

test('cleanup during creation is rejected, then succeeds', async () => {
  runs.clear(); archives.clear();
  const fake = makeFakeCluster({ gateApply: true });
  const pending = createRun('prometheus', quiet(), fake.deps);
  await new Promise((r) => setTimeout(r, 10));
  const creatingId = [...runs.keys()].find((id) => runs.get(id).status === 'creating');
  assert.ok(creatingId, 'a creating run is registered');
  await assert.rejects(cleanupRun(creatingId, tmpdir(), fake.deps), /still being created/);
  fake.release();
  const run = await pending;
  assert.equal(run.status, 'ready');
});

test('cleanup failure is recorded with retry, archive is immutable', async () => {
  runs.clear(); archives.clear();
  const dir = mkdtempSync(join(tmpdir(), 'lab-arch-'));
  const fake = makeFakeCluster();
  const run = await createRun('prometheus', quiet(), fake.deps);
  // Inject a namespace-deletion failure for this run only.
  const failNs = new Set([run.ns]);
  const origExec = fake.deps.exec;
  fake.deps.exec = async (args) => {
    const a = args.join(' ');
    if (a.includes('delete namespace') && failNs.has(args[args.indexOf('namespace') + 1])) {
      throw new Error('injected delete failure');
    }
    return origExec(args);
  };
  await assert.rejects(cleanupRun(run.id, dir, fake.deps), /Namespace deletion failed/);
  assert.equal(run.status, 'cleanup-failed');
  assert.match(run.error, /injected delete failure/);
  assert.ok(fake.namespaces.has(run.ns), 'namespace retained for retry');
  // retry succeeds
  failNs.clear();
  await cleanupRun(run.id, dir, fake.deps);
  assert.equal(run.status, 'deleted');
  assert.ok(!fake.namespaces.has(run.ns));
  // archive deep-copy: later mutations must not leak in
  run.timeline.points.push({ at: 'mutated', offeredRps: 999 });
  run.events.push({ at: 'mutated', type: 'x', data: {} });
  const file = JSON.parse(readFileSync(join(dir, `archive-${run.id}.json`), 'utf8'));
  assert.ok(!file.timeline.points.some((p) => p.at === 'mutated'));
  assert.ok(!file.events.some((e) => e.at === 'mutated'));
  const mem = archives.get(run.id);
  assert.ok(!mem.timeline.points.some((p) => p.at === 'mutated'));
});

test('traffic stops before the snapshot so final counts are stable', async () => {
  runs.clear(); archives.clear();
  const dir = mkdtempSync(join(tmpdir(), 'lab-arch-'));
  const fake = makeFakeCluster();
  const run = await createRun('prometheus', quiet(), fake.deps);
  let stopped = false;
  run.load = {
    active: true,
    total: 0,
    state: () => ({ active: run.load.active, total: run.load.total }),
    stop: async () => { stopped = true; run.load.total = 42; run.load.active = false; return run.load.state(); },
  };
  await cleanupRun(run.id, dir, fake.deps);
  assert.ok(stopped, 'stop ran before snapshot');
  const file = JSON.parse(readFileSync(join(dir, `archive-${run.id}.json`), 'utf8'));
  assert.equal(file.load.total, 42);
});

test('cleanup exposes progress while traffic drains and namespace deletion waits', async () => {
  runs.clear(); archives.clear();
  const dir = mkdtempSync(join(tmpdir(), 'lab-progress-'));
  const fake = makeFakeCluster();
  const run = await createRun('connections', quiet(), fake.deps);
  let releaseTraffic;
  run.load = {
    active: true,
    state: () => ({ active: run.load.active }),
    stop: () => new Promise((resolve) => { releaseTraffic = () => { run.load.active = false; resolve(); }; }),
  };
  let releaseDelete;
  const origExec = fake.deps.exec;
  fake.deps.exec = async (args) => {
    if (args.includes('namespace') && args.includes('delete')) {
      await new Promise((resolve) => { releaseDelete = resolve; });
    }
    return origExec(args);
  };
  const pending = cleanupRun(run.id, dir, fake.deps);
  assert.equal(describeRun(run).cleanup.stage, 'stop-traffic');
  assert.equal(describeRun(run).cleanup.completed, 0);
  assert.equal(run.status, 'deleting');
  await assert.rejects(cleanupRun(run.id, dir, fake.deps), /already in progress/);
  releaseTraffic();
  for (let i = 0; i < 100 && !releaseDelete; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(releaseDelete);
  assert.equal(describeRun(run).cleanup.stage, 'delete-namespace');
  assert.equal(describeRun(run).cleanup.completed, 3);
  assert.ok(archives.has(run.id));
  assert.ok(fake.forwards[0].closed);
  releaseDelete();
  await pending;
  assert.equal(run.status, 'deleted');
  assert.equal(describeRun(run).cleanup.completed, 4);
  assert.equal(describeRun(run).cleanup.stage, 'complete');
});

test('cleanup-failed namespaces keep their slot until deletion succeeds', async () => {
  runs.clear(); archives.clear();
  const fake = makeFakeCluster();
  const a = await createRun('prometheus', () => {}, fake.deps);
  const b = await createRun('prometheus', () => {}, fake.deps);
  // Inject a namespace-deletion failure for A only.
  const failNs = new Set([a.ns]);
  const origExec = fake.deps.exec;
  fake.deps.exec = async (args) => {
    const s = args.join(' ');
    if (s.includes('delete namespace') && failNs.has(args[args.indexOf('namespace') + 1])) {
      throw new Error('injected delete failure');
    }
    return origExec(args);
  };
  await assert.rejects(cleanupRun(a.id, tmpdir(), fake.deps), /Namespace deletion failed/);
  assert.equal(runs.get(a.id).status, 'cleanup-failed');
  assert.equal(runs.get(a.id).cleanupAttempts, 1);
  assert.ok(fake.namespaces.has(a.ns), 'failed-cleanup namespace retained');
  // Failed cleanup keeps its slot even after the remaining slots are filled.
  for (let i = 2; i < MAX_ACTIVE_RUNS; i++) await createRun('connections', quiet(), fake.deps);
  const countedActive = activeRuns().length;
  assert.equal(countedActive, MAX_ACTIVE_RUNS);
  await assert.rejects(createRun('prometheus', () => {}, fake.deps), /Run limit reached/);
  assert.equal(fake.namespaces.size, MAX_ACTIVE_RUNS, 'no namespace leaked for the rejected run');
  // Retry succeeds after the failure clears; attempts are recorded.
  failNs.clear();
  await cleanupRun(a.id, tmpdir(), fake.deps);
  assert.equal(runs.get(a.id).status, 'deleted');
  assert.equal(runs.get(a.id).cleanupAttempts, 2);
});

test('creation rollback retains a cleanup-failed record when the namespace survives', async () => {
  runs.clear(); archives.clear();
  const fake = makeFakeCluster();
  // Fail the rollout step (after the namespace exists), then fail its deletion.
  let failRollout = true;
  let failDelete = true;
  const origExec = fake.deps.exec;
  fake.deps.exec = async (args) => {
    const s = args.join(' ');
    if (failRollout && s.includes('rollout status')) throw new Error('injected rollout failure');
    if (failDelete && s.includes('delete namespace')) throw new Error('injected delete failure');
    return origExec(args);
  };
  await assert.rejects(createRun('prometheus', () => {}, fake.deps), /rollback could not delete/);
  const [id] = [...runs.keys()];
  assert.equal(runs.get(id).status, 'cleanup-failed');
  assert.equal(activeRuns().length, 1, 'leaked namespace keeps its slot');
  failRollout = false;
  failDelete = false;
  await cleanupRun(id, tmpdir(), fake.deps);
  assert.equal(runs.get(id).status, 'deleted');
});
test('parseHpa reads v2 external current metric with units and target', () => {
  const items = [{
    metadata: { name: 'keda-hpa-app-prometheus' },
    spec: {
      scaleTargetRef: { name: 'app' },
      metrics: [{ type: 'External', external: { metric: { name: 's0-prometheus' }, target: { type: 'AverageValue', averageValue: '5' } } }],
    },
    status: {
      currentReplicas: 3, desiredReplicas: 4,
      currentMetrics: [{ type: 'External', external: { metric: { name: 's0-prometheus' }, current: { averageValue: '27', averageUtilization: 0 } } }],
    },
  }];
  const hpa = parseHpa(items);
  assert.equal(hpa.name, 'keda-hpa-app-prometheus');
  assert.equal(hpa.external.current, 27);
  assert.equal(hpa.external.target, 5);
  assert.equal(hpa.external.name, 's0-prometheus');
  assert.equal(hpa.currentCPU, null);
});

test('parseHpa reads v2 resource utilization and target', () => {
  const items = [{
    metadata: { name: 'app' },
    spec: {
      scaleTargetRef: { name: 'app' },
      metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 60 } } }],
    },
    status: {
      currentReplicas: 2, desiredReplicas: 2,
      currentMetrics: [{ type: 'Resource', resource: { name: 'cpu', current: { averageUtilization: 42, averageValue: '42m' } } }],
    },
  }];
  const hpa = parseHpa(items);
  assert.equal(hpa.currentCPU, 42);
  assert.equal(hpa.cpuTarget, 60);
  assert.equal(hpa.external, null);
  assert.equal(parseHpa([]), null);
});
test('malformed and unknown run ids are rejected', async () => {
  runs.clear(); archives.clear();
  const fake = makeFakeCluster();
  assert.throws(() => validateRunId('../x'), /Invalid run id/);
  await assert.rejects(cleanupRun('deadbeef', tmpdir(), fake.deps), /Unknown run/);
});

test('parseQuantity normalizes milli/plain/scientific quantities', async () => {
  const { parseQuantity } = await import('./runs.mjs');
  assert.equal(parseQuantity('3200m'), 3.2);
  assert.equal(parseQuantity('5'), 5);
  assert.equal(parseQuantity('42m'), 0.042);
  assert.equal(parseQuantity('1e3'), 1000);
  assert.equal(parseQuantity('10Ki'), 10240);
  assert.equal(parseQuantity(7), 7);
  assert.equal(parseQuantity('bogus'), null);
  assert.equal(parseQuantity(null), null);
});

test('parseHpa keeps raw quantity strings alongside normalized values', async () => {
  const { parseHpa } = await import('./runs.mjs');
  const hpa = parseHpa([{
    metadata: { name: 'keda-hpa-app-prometheus' },
    spec: { scaleTargetRef: { name: 'app' }, metrics: [{ type: 'External', external: { metric: { name: 's0' }, target: { type: 'AverageValue', averageValue: '5' } } }] },
    status: { currentReplicas: 5, desiredReplicas: 5, currentMetrics: [{ type: 'External', external: { metric: { name: 's0' }, current: { averageValue: '3200m' } } }] },
  }]);
  assert.equal(hpa.external.current, 3.2);
  assert.equal(hpa.external.currentRaw, '3200m');
  assert.equal(hpa.external.target, 5);
});

test('cleanup of an already-absent namespace succeeds and frees the slot', async () => {
  const { makeFakeCluster } = await import('./test-fake.mjs');
  const { runs, archives, createRun, cleanupRun, activeRuns } = await import('./runs.mjs');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  runs.clear(); archives.clear();
  const fake = makeFakeCluster();
  const run = await createRun('prometheus', () => {}, fake.deps);
  // Namespace deleted out-of-band (already absent when cleanup runs).
  fake.namespaces.delete(run.ns);
  const dir = mkdtempSync(join(tmpdir(), 'lab-arch-'));
  await cleanupRun(run.id, dir, fake.deps);
  assert.equal(run.status, 'deleted');
  assert.equal(activeRuns().length, 0, 'absent namespace frees its slot');
  assert.ok(archives.has(run.id), 'evidence still snapshotted');
});

test('per-lesson run shapes pin replicas and scalers', async () => {
  const { makeFakeCluster } = await import('./test-fake.mjs');
  const { runs, archives, createRun, runConfig, RUN_LESSONS } = await import('./runs.mjs');
  assert.equal(RUN_LESSONS.size, 16);
  assert.deepEqual(runConfig('capacity'), { replicas: 1, scaler: null });
  assert.deepEqual(runConfig('disruptions'), { replicas: 3, scaler: null });
  assert.deepEqual(runConfig('autoscale'), { replicas: 2, scaler: 'cpu-hpa' });
  assert.deepEqual(runConfig('prometheus'), { replicas: 2, scaler: 'keda' });
  runs.clear(); archives.clear();
  const fake = makeFakeCluster();
  const cap = await createRun('capacity', () => {}, fake.deps);
  assert.equal(cap.status, 'ready');
  const appliedKinds = fake.applied.filter(([ns]) => ns === cap.ns).map(([, kind]) => kind);
  assert.ok(!appliedKinds.includes('HorizontalPodAutoscaler'), 'capacity provisions no scaler');
  assert.ok(!appliedKinds.includes('ScaledObject'), 'capacity provisions no scaler');
  assert.equal(fake.namespaces.get(cap.ns).deployments.app, 1);
  const dis = await createRun('disruptions', () => {}, fake.deps);
  assert.equal(fake.namespaces.get(dis.ns).deployments.app, 3);
});
