import test from 'node:test';
import assert from 'node:assert/strict';
import { PROFILES, LOAD_LIMITS, validateProfile, LoadSession } from './load.mjs';
import { createHistory, pushPoint, pushMilestone } from './timeline.mjs';
import { validateResetTarget, RESET_TARGETS } from './reset.mjs';

test('load profiles stay within laptop-safe bounds', () => {
  for (const [name, p] of Object.entries(PROFILES)) {
    assert.ok(p.initialRps >= 1 && p.initialRps <= LOAD_LIMITS.maxRps, name);
    assert.ok(p.maxRps <= LOAD_LIMITS.maxRps, name);
    assert.equal(LOAD_LIMITS.endpoint, 'http://127.0.0.1:8080');
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

test('reset accepts only known lesson targets', () => {
  assert.doesNotThrow(() => validateResetTarget('cpu'));
  assert.doesNotThrow(() => validateResetTarget('prometheus'));
  assert.doesNotThrow(() => validateResetTarget('baseline'));
  assert.throws(() => validateResetTarget('kubectl; rm -rf'), /Unknown reset target/);
  assert.ok(RESET_TARGETS.cpu.make.includes('hpa-up'));
  assert.ok(RESET_TARGETS.prometheus.make.includes('prometheus-up'));
});
