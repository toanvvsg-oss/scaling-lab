import test from 'node:test';
import assert from 'node:assert/strict';
import { PROFILES, CPU_PROFILES, LOAD_LIMITS, validateProfile, LoadSession } from './load.mjs';
import { createHistory, pushPoint, pushMilestone, cursorAt, filterByTime, marksUpTo, deriveExplanation } from './timeline.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('k8s manifests keep metric queries scoped to their namespace', () => {
  const scaled = readFileSync(join(repoRoot, 'k8s/prometheus-scaledobject.yaml'), 'utf8');
  assert.match(scaled, /namespace="scaling-lab"/, 'legacy scaler must not observe run traffic');
  assert.ok(!scaled.includes('{job="scaling-app"}'), 'no unscoped job selector may remain');
  const prom = readFileSync(join(repoRoot, 'k8s/prometheus.yaml'), 'utf8');
  assert.match(prom, /scaling-lab\|scaling-run-\[a-z0-9\]\+/);
  assert.match(prom, /target_label: labrun/);
  assert.ok(!prom.includes('names:\n              names: [scaling-lab]'), 'exact-name allowlist cannot wildcard run namespaces');
  const grafana = readFileSync(join(repoRoot, 'k8s/grafana.yaml'), 'utf8');
  assert.match(grafana, /namespace=~\\"scaling-run-\$run\\"/);
  assert.ok(!grafana.includes('scaling-lab|scaling-run-$run'), 'run panels must exclude the shared namespace');
  assert.match(grafana, /namespace=\\"scaling-lab\\"/, 'legacy panel keeps the shared namespace explicitly');
});
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
test('rapid stop/start never runs two generators concurrently', async () => {
  const { default: http } = await import('node:http');
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'x-pod': 'p1', 'x-request-id': 'r', 'x-edge-connection': '1', 'x-app-connection': '1' });
    res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const s = new LoadSession(() => {}, { endpoint: `http://127.0.0.1:${port}`, cpu: true });
    await s.start('steady', { durationMs: 120000 });
    await new Promise((r) => setTimeout(r, 300));
    await s.stop('test');
    const before = hits;
    await s.start('steady', { durationMs: 120000 });
    await new Promise((r) => setTimeout(r, 510));
    const fresh = hits - before;
    // 6 rps * 0.51s ≈ 3 new requests; two overlapping loops would send ~6+.
    assert.ok(fresh <= 4, `expected at most 4 requests after restart, got ${fresh}`);
    await s.stop('test');
  } finally {
    srv.close();
  }
});
test('delayed responses settle before final counters are reported', async () => {
  const { default: http } = await import('node:http');
  const srv = http.createServer((req, res) => {
    setTimeout(() => { res.writeHead(200, { 'x-pod': 'p1', 'x-request-id': 'r', 'x-edge-connection': '1', 'x-app-connection': '1' }); res.end('{}'); }, 250);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const events = [];
    const s = new LoadSession(() => events.push(0), { endpoint: `http://127.0.0.1:${port}` });
    await s.start('steady', { durationMs: 30000 });
    await new Promise((r) => setTimeout(r, 2000));
    const stopped = await s.stop('test');
    assert.equal(stopped.active, false);
    const total = s.total;
    assert.ok(total > 0);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(s.total, total, 'final counters frozen after stop');
    assert.equal(s._inflight.size, 0);
  } finally {
    srv.close();
  }
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
  assert.equal(MAX_ACTIVE_RUNS, 7);
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
test('cursor helpers filter points, events, and milestones by time', () => {
  const pts = [0, 10, 20, 30].map((s) => ({ at: new Date(1000000 + s * 1000).toISOString(), offeredRps: s }));
  assert.equal(cursorAt(pts, 1000000 + 15000), 1);
  assert.equal(cursorAt(pts, 0), -1);
  const evs = [{ at: pts[0].at }, { at: pts[2].at }];
  assert.equal(filterByTime(evs, null).length, 2);
  assert.equal(filterByTime(evs, 1000000 + 5000).length, 1);
  const tl = { milestones: [{ at: pts[1].at, kind: 'a' }, { at: pts[3].at, kind: 'b' }] };
  assert.deepEqual(marksUpTo(tl, 1000000 + 15000).map((m) => m.kind), ['a']);
  assert.equal(marksUpTo(tl, null).length, 2);
});

test('explanation derives measured delays from points', () => {
  const t0 = 1000000;
  const pts = [
    { at: new Date(t0).toISOString(), offeredRps: 0, observedRps: 0, desired: 2, ready: 2 },
    { at: new Date(t0 + 5000).toISOString(), offeredRps: 30, observedRps: 0, desired: 2, ready: 2 },
    { at: new Date(t0 + 15000).toISOString(), offeredRps: 30, observedRps: 27, desired: 5, ready: 5 },
  ];
  const text = deriveExplanation(pts, 'prometheus');
  assert.match(text, /Measured in this run/);
  assert.match(text, /~10s later/);
  assert.equal(deriveExplanation(pts.slice(0, 1), 'prometheus'), '');
});
test('reset accepts only known lesson targets', () => {
  assert.doesNotThrow(() => validateResetTarget('cpu'));
  assert.doesNotThrow(() => validateResetTarget('prometheus'));
  assert.doesNotThrow(() => validateResetTarget('baseline'));
  assert.throws(() => validateResetTarget('kubectl; rm -rf'), /Unknown reset target/);
  assert.ok(RESET_TARGETS.cpu.make.includes('hpa-up'));
  assert.ok(RESET_TARGETS.prometheus.make.includes('prometheus-up'));
});

test('explanation is lesson-specific, not Prometheus-framed', async () => {
  const { deriveExplanation } = await import('./timeline.mjs');
  const t0 = 1000000;
  const pts = [
    { at: new Date(t0).toISOString(), offeredRps: 0, actual: 2, ready: 2, endpoints: 2 },
    { at: new Date(t0 + 5000).toISOString(), offeredRps: 0, actual: 2, ready: 2, endpoints: 2 },
    { at: new Date(t0 + 10000).toISOString(), offeredRps: 0, actual: 2, ready: 2, endpoints: 2 },
  ];
  const conn = deriveExplanation(pts, 'connections');
  assert.ok(!/scraped|desired replicas/i.test(conn), 'no Prometheus wording for connections');
  assert.match(conn, /edge connection/i);
  const cpu = deriveExplanation([
    { at: new Date(t0).toISOString(), offeredRps: 0, currentCPU: 5, desired: 2, ready: 2 },
    { at: new Date(t0 + 30000).toISOString(), offeredRps: 6, currentCPU: 5, desired: 2, ready: 2 },
    { at: new Date(t0 + 90000).toISOString(), offeredRps: 6, currentCPU: 75, desired: 4, ready: 4 },
  ], 'autoscale');
  assert.match(cpu, /CPU crossed 60%/);
});

test('cursor filtering hides then reveals trace events by time', async () => {
  const { filterByTime } = await import('./timeline.mjs');
  const evs = [
    { at: new Date(1000000).toISOString(), type: 'sample' },
    { at: new Date(1020000).toISOString(), type: 'sample' },
    { at: new Date(1040000).toISOString(), type: 'hpa' },
  ];
  assert.equal(filterByTime(evs, 999000).length, 0, 'scrub before events hides the trace');
  assert.equal(filterByTime(evs, 1010000).length, 1);
  assert.equal(filterByTime(evs, 1050000).length, 3, 'later scrub reveals them');
});

test('timeline points store bounded pod/endpoint snapshots', async () => {
  const { createHistory, pushPoint } = await import('./timeline.mjs');
  const h = createHistory();
  const pods = [{ name: 'app-x-old1', ready: true, terminating: false }];
  pushPoint(h, { offeredRps: 0, podsSnapshot: pods, endpointsSnapshot: [{ pod: 'app-x-old1', ready: true }] });
  assert.deepEqual(h.points[0].podsSnapshot, pods);
  assert.equal(h.points[0].endpointsSnapshot.length, 1);
});
