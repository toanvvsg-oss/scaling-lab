import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runs, archives, createRun, cleanupRun, validateRunId, MAX_ACTIVE_RUNS,
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
  await assert.rejects(createRun('prometheus', quiet(), fake.deps), /Run limit reached/);
  assert.equal(MAX_ACTIVE_RUNS, 2);
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

test('malformed and unknown run ids are rejected', async () => {
  runs.clear(); archives.clear();
  const fake = makeFakeCluster();
  assert.throws(() => validateRunId('../x'), /Invalid run id/);
  await assert.rejects(cleanupRun('deadbeef', tmpdir(), fake.deps), /Unknown run/);
});
