import test from 'node:test';
import assert from 'node:assert/strict';
import { PROFILES, CPU_PROFILES, LOAD_LIMITS, validateProfile, LoadSession } from './load.mjs';
import { createHistory, pushPoint, pushMilestone } from './timeline.mjs';
import { validateResetTarget, RESET_TARGETS } from './reset.mjs';
import { createRunId, validateRunId, namespaceFor, buildArchive, MAX_ACTIVE_RUNS, RUN_LESSONS } from './runs.mjs';
import { rateQueryForRun, upQueryForRun, LEGACY_RATE_QUERY } from './prometheus.mjs';

test('load profiles stay within laptop-safe bounds', () => {
  for (const [name, p] of Object.entries(PROFILES)) {
    assert.ok(p.phases.length >= 1, name);
    assert.ok(Math.abs(p.phases.reduce((a, x) => a + x.frac, 0) - 1) < 1e-9, `${name} phases cover the duration`);
    for (const phase of p.phases) {
      assert.ok(phase.rps >= 1 && phase.rps <= LOAD_LIMITS.maxRps, `${name}/${phase.label}`);
    }
    assert.ok(p.maxRps <= LOAD_LIMITS.maxRps, name);
    assert.equal(LOAD_LIMITS.endpoint, 'http://127.0.0.1:8080');
  }
  for (const [name, p] of Object.entries(CPU_PROFILES)) {
    assert.ok(p.path.startsWith('/cpu'), `${name} burns CPU`);
    assert.ok(p.maxRps <= 12, `${name} stays laptop-safe`);
  }
  assert.throws(() => validateProfile('nope'), /Unknown profile/);
});

test('second load session is rejected clearly', async () => {
  const events = [];
  const s = new LoadSession((t, d) => events.push([t, d]));
  await s.start('steady');
  await assert.rejects(() => s.start('ramp'), /already running/);
  await s.stop('test');
  assert.equal(s.active, false);
  assert.ok(s.total >= 0);
});

test('timeline history is bounded and distinguishes stale from zero', () => {
  const h = createHistory();
  pushPoint(h, { offeredRps: 10, observedRps: 0, stale: false, desired: 2, actual: 2, ready: 2 });
  pushPoint(h, { offeredRps: 10, observedRps: null, stale: true, desired: 2, actual: 2, ready: 2 });
  assert.equal(h.points[0].observedRps, 0);
  assert.equal(h.points[1].observedRps, null);
  assert.equal(h.points[1].stale, true);
  pushMilestone(h, { kind: 'load', text: 'up', observer: 'load controller' });
  assert.equal(h.milestones.length, 1);
});

test('timeline points keep measured offered rate plus target, stale stays null', () => {
  const h = createHistory();
  pushPoint(h, { offeredRps: 14, offeredTarget: 15, observedRps: null, stale: true, desired: 2, actual: 2, ready: 2 });
  assert.equal(h.points[0].offeredRps, 14);
  assert.equal(h.points[0].offeredTarget, 15);
  assert.equal(h.points[0].observedRps, null);
  assert.equal(h.points[0].stale, true);
});

test('load phases progress over the session duration', () => {
  const s = new LoadSession(() => {}, { cpu: false });
  s.profile = 'ramp';
  s.durationMs = 120000;
  s.manualDelta = 0;
  assert.equal(s.phaseAt(0), 0);
  assert.equal(s.phaseAt(29999), 0);
  assert.equal(s.phaseAt(30000), 1);
  assert.equal(s.phaseAt(90000), 3);
  assert.equal(s.effectiveRps(0), 5);
  s.manualDelta = 5;
  assert.equal(s.effectiveRps(0), 10);
  s.manualDelta = 1000;
  assert.equal(s.effectiveRps(0), 30);
});
test('load session clamps rate changes to profile bounds and stops cleanly', async () => {
  const events = [];
  const s = new LoadSession((t, d) => events.push([t, d]));
  await s.start('steady');
  assert.equal(s.setRps(1000).targetRps, 30);
  assert.equal(s.setRps(-100).targetRps, 5);
  const stopped = await s.stop('test');
  assert.equal(stopped.active, false);
  assert.equal(stopped.offeredLastSecond, 0);
  const idle = await s.stop('test');
  assert.equal(idle.active, false);
});
test('run ids are server-shaped, validated, and scoped to one namespace', () => {
  assert.match(createRunId(), /^[a-z0-9]{8}$/);
  assert.equal(namespaceFor('abc12345'), 'scaling-run-abc12345');
  assert.throws(() => validateRunId('../evil'), /Invalid run id/);
  assert.throws(() => validateRunId('scaling-lab'), /Invalid run id/);
  assert.throws(() => validateRunId(undefined), /Invalid run id/);
  assert.throws(() => namespaceFor('app'), /Invalid run id/);
  assert.ok(RUN_LESSONS.has('prometheus'));
  assert.equal(MAX_ACTIVE_RUNS, 2);
});

test('run metric queries carry the run selector, legacy query stays namespaced', () => {
  assert.ok(rateQueryForRun('abc12345').includes('labrun="abc12345"'));
  assert.ok(upQueryForRun('abc12345').includes('labrun="abc12345"'));
  assert.ok(LEGACY_RATE_QUERY.includes('namespace="scaling-lab"'));
  assert.throws(() => rateQueryForRun('../../x'), /Invalid run id/);
});

test('every lesson can run isolated', () => {
  for (const id of ['connections', 'timeouts', 'shutdown', 'rollout', 'streaming', 'autoscale', 'prometheus']) {
    assert.ok(RUN_LESSONS.has(id), id);
  }
  assert.equal(RUN_LESSONS.size, 7);
});
test('run evidence archive keeps values and timestamps', () => {
  const fake = {
    id: 'abc12345', lesson: 'prometheus', ns: 'scaling-run-abc12345',
    createdAt: '2026-10-10T00:00:00.000Z', status: 'ready', error: null, steps: [],
    load: { state: () => ({ active: false, total: 10 }) }, result: { status: 'pass' },
    timeline: { points: [{ at: 't1', observedAt: 's1', offeredRps: 5 }], milestones: [] },
    events: [{ at: 't0', type: 'run', data: {} }],
  };
  const archive = buildArchive(fake);
  assert.equal(archive.run, 'abc12345');
  assert.equal(archive.namespace, 'scaling-run-abc12345');
  assert.equal(archive.timeline.points[0].observedAt, 's1');
  assert.ok(archive.archivedAt);
});
test('reset accepts only known lesson targets', () => {
  assert.doesNotThrow(() => validateResetTarget('cpu'));
  assert.doesNotThrow(() => validateResetTarget('prometheus'));
  assert.doesNotThrow(() => validateResetTarget('baseline'));
  assert.throws(() => validateResetTarget('kubectl; rm -rf'), /Unknown reset target/);
  assert.ok(RESET_TARGETS.cpu.make.includes('hpa-up'));
  assert.ok(RESET_TARGETS.prometheus.make.includes('prometheus-up'));
});
