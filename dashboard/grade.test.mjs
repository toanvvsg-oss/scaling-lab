import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeConnections, gradeTimeout, gradeShutdown, gradeRollout, gradeStream, gradeCapacity } from './grade.mjs';

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

function capStep(rate, over = {}) {
  return {
    rate, offered: 120, started: 120, dropped: 0, completed: 118, failed: 2, timeouts: 0,
    timely: 115, missedSlots: 0, peakInflight: 12, elapsedMs: 12000,
    p50: 8, p95: 40, p99: 120, successRps: 9.8, goodputRps: 9.6, errorPct: 1.7, cpu: null,
    ...over,
  };
}
const capCfg = { replicas: 1, work: 'cheap', path: '/fast' };

test('capacity grader finds the highest SLO-meeting rate on clean steps', () => {
  const r = gradeCapacity({
    steps: [capStep(5), capStep(10), capStep(15, { p95: 900 })],
    config: capCfg, sloP95Ms: 500, sloErrorPct: 5, plannedRates: [5, 10, 15],
  });
  assert.equal(r.status, 'pass');
  assert.ok(r.checks.every((c) => c.pass));
  assert.equal(r.evidence.capacityRps, 10);
});

test('capacity grader passes with an explicit no-rate-met finding instead of a number', () => {
  const r = gradeCapacity({
    steps: [capStep(5, { p95: 1000 }), capStep(10, { p95: 1200 })],
    config: capCfg, sloP95Ms: 200, sloErrorPct: 5, plannedRates: [5, 10],
  });
  assert.equal(r.status, 'pass');
  assert.ok(r.checks.every((c) => c.pass), 'negative SLO verdict is determinate, not a failure');
  assert.equal(r.evidence.capacityRps, null);
  assert.equal(r.evidence.capacityWithheld, true);
  assert.match(r.checks.at(-1).label, /No generator-clean rate met/);
});

test('capacity grader is inconclusive when every step is generator-limited', () => {
  const r = gradeCapacity({
    steps: [capStep(5, { dropped: 30, started: 90, completed: 88 }), capStep(10, { dropped: 50, started: 70, completed: 68 })],
    config: capCfg, sloP95Ms: 500, sloErrorPct: 5, plannedRates: [5, 10],
  });
  assert.equal(r.status, 'inconclusive');
  assert.equal(r.evidence.capacityRps, null);
  assert.ok(r.checks.some((c) => !c.pass));
});

test('capacity grader excludes missed-slot steps and withholds when all missed', () => {
  const partial = gradeCapacity({
    steps: [capStep(5, { missedSlots: 9, p95: 20 }), capStep(10)],
    config: capCfg, sloP95Ms: 500, sloErrorPct: 5, plannedRates: [5, 10],
  });
  assert.equal(partial.status, 'pass');
  assert.equal(partial.evidence.capacityRps, 10);
  assert.equal(partial.evidence.verdicts.find((v) => v.rate === 5).generatorLimited, true);
  const all = gradeCapacity({
    steps: [capStep(5, { missedSlots: 4 }), capStep(10, { missedSlots: 11 })],
    config: capCfg, sloP95Ms: 500, sloErrorPct: 5, plannedRates: [5, 10],
  });
  assert.equal(all.status, 'inconclusive');
  assert.equal(all.evidence.capacityRps, null);
});

test('capacity grader is inconclusive on unsettled accounting or missing rates', () => {
  const bad = gradeCapacity({
    steps: [{ ...capStep(5), started: 100, completed: 90, failed: 2 }],
    config: capCfg, sloP95Ms: 500, sloErrorPct: 5, plannedRates: [5, 10],
  });
  assert.equal(bad.status, 'inconclusive');
  assert.equal(bad.evidence.capacityRps, null);
  const thin = gradeCapacity({
    steps: [capStep(5, { completed: 3, failed: 0, timely: 3, started: 3, offered: 120, dropped: 117 })],
    config: capCfg, sloP95Ms: 500, sloErrorPct: 5, plannedRates: [5],
  });
  assert.equal(thin.status, 'inconclusive');
  assert.throws(() => gradeCapacity({ steps: [], config: capCfg, sloP95Ms: 500, sloErrorPct: 5, plannedRates: [] }), /plannedRates/);
  assert.throws(() => gradeCapacity({ steps: [capStep(5)], config: capCfg, sloP95Ms: 5, sloErrorPct: 5, plannedRates: [5] }), /sloP95Ms/);
});

test('hpa-reaction grader requires decision, lag, slow-startup, and recovery evidence', async () => {
  const { gradeHpaReact } = await import('./grade.mjs');
  const series = [
    { at: 't0', phase: 'hpa-scale-out', desired: 2, ready: 2, currentCPU: 30 },
    { at: 't1', phase: 'hpa-scale-out', desired: 4, ready: 2, currentCPU: 120 },
    { at: 't2', phase: 'hpa-scale-out', desired: 4, ready: 4, currentCPU: 70 },
    { at: 't3', phase: 'stabilization', desired: 2, ready: 3, currentCPU: 20 },
  ];
  const good = gradeHpaReact({
    baseline: { target: 60, replicas: 2, desired: 2 },
    series, predictDesired: 4,
    slowStartup: { kind: 'template-gated-rollout', gapObserved: true, desiredDuring: 4, unreadySamples: 5, restored: true },
    recovery: { samples: 5 },
  });
  assert.equal(good.status, 'pass');
  assert.ok(good.checks.every((c) => c.pass));
  assert.equal(good.evidence.desiredPeak, 4);
  const flat = gradeHpaReact({
    baseline: { target: 60, replicas: 2, desired: 2 },
    series: [{ at: 't0', desired: 2, ready: 2, currentCPU: null }],
    predictDesired: 5, slowStartup: null, recovery: { samples: 1 },
  });
  assert.equal(flat.status, 'inconclusive');
  assert.ok(flat.checks.some((c) => !c.pass));
  assert.throws(() => gradeHpaReact({ baseline: null, series: [] }), /baseline/);
});

test('pending grader requires reasoned Pending and full recovery', async () => {
  const { gradePending } = await import('./grade.mjs');
  const good = gradePending({
    constrained: { desired: 5, scheduled: 0, running: 0, ready: 0, pending: 5 },
    restored: { desired: 2, scheduled: 2, running: 2, ready: 2, pending: 0 },
    events: [{ reason: 'FailedScheduling', message: "0/3 nodes are available: 3 node(s) didn't match Pod's node affinity" }],
  });
  assert.equal(good.status, 'pass');
  assert.ok(good.checks.every((c) => c.pass));
  const unexplained = gradePending({
    constrained: { desired: 5, scheduled: 0, running: 0, ready: 0, pending: 5 },
    restored: { desired: 2, scheduled: 2, running: 2, ready: 1, pending: 1 },
    events: [],
  });
  assert.equal(unexplained.status, 'inconclusive');
});

test('hpa-reaction grader keeps rollout stall separate from scale-out lag', async () => {
  const { gradeHpaReact } = await import('./grade.mjs');
  // Rollout-phase desired>ready must NOT count as HPA scale-out lag.
  const rolloutOnly = gradeHpaReact({
    baseline: { target: 60, replicas: 2, desired: 2 },
    series: [
      { at: 't0', phase: 'hpa-scale-out', desired: 2, ready: 2, currentCPU: 30 },
      { at: 't1', phase: 'template-gated-rollout', desired: 4, ready: 2, currentCPU: 30 },
    ],
    predictDesired: 2,
    slowStartup: { kind: 'template-gated-rollout', gapObserved: true, desiredDuring: 4, unreadySamples: 4, restored: true },
    recovery: { samples: 4 },
  });
  assert.equal(rolloutOnly.status, 'inconclusive', 'rollout stall is not HPA scale-out evidence');
  assert.equal(rolloutOnly.checks[2].pass, false);
  // A failed probe restore fails the run loudly instead of passing silently.
  const unrestored = gradeHpaReact({
    baseline: { target: 60, replicas: 2, desired: 2 },
    series: [{ at: 't0', phase: 'hpa-scale-out', desired: 4, ready: 2, currentCPU: 120 }],
    predictDesired: 4,
    slowStartup: { kind: 'template-gated-rollout', gapObserved: true, desiredDuring: 4, unreadySamples: 4, restored: false, restoreError: 'patch failed' },
    recovery: { samples: 4 },
  });
  assert.equal(unrestored.status, 'inconclusive');
  assert.match(unrestored.checks[4].label, /patch failed/);
});

test('resources grader needs denominator, cpu.stat throttle, and OOM proof', async () => {
  const { gradeResources } = await import('./grade.mjs');
  const good = gradeResources({
    denom: { utilBefore: 300, utilAfter: 70, desiredBefore: 5, desiredAfter: 3, trafficSame: true },
    throttle: { baseDeltaUsec: 5000, tightDeltaUsec: 900000, cappedCpuM: 150, capped: true, samePod: true, podTight: 'app-x-1', tightUsageMs: 9000 },
    oom: { restartsBefore: 0, restartsAfter: 1, reason: 'app-x:OOMKilled', reasons: ['app-x:OOMKilled'] },
    restored: true,
  });
  assert.equal(good.status, 'pass');
  assert.ok(good.checks.every((c) => c.pass));
  const noThrottle = gradeResources({
    denom: { utilBefore: 300, utilAfter: 70, desiredBefore: 5, desiredAfter: 3, trafficSame: true },
    throttle: { baseDeltaUsec: 5000, tightDeltaUsec: 6000, cappedCpuM: 900, capped: false },
    oom: { restartsBefore: 0, restartsAfter: 1, reason: 'app-x:OOMKilled', reasons: [] },
    restored: true,
  });
  assert.equal(noThrottle.status, 'inconclusive', 'latency-only throttling claims fail without cpu.stat evidence');
  const noOom = gradeResources({
    denom: { utilBefore: 300, utilAfter: 70, desiredBefore: 5, desiredAfter: 3, trafficSame: true },
    throttle: { baseDeltaUsec: 1000, tightDeltaUsec: 500000, cappedCpuM: 150, capped: true },
    oom: { restartsBefore: 0, restartsAfter: 0, reason: null, reasons: [] },
    restored: true,
  });
  assert.equal(noOom.status, 'inconclusive');
  const noCoverage = gradeResources({
    denom: { utilBefore: 300, utilAfter: 70, desiredBefore: 5, desiredAfter: 3, trafficSame: false, windows: { before: { offered: 80, successes: 16, failures: 0 }, after: { offered: 0, successes: 0, failures: 0, reasons: ['generation ended before the window end'] } } },
    throttle: { baseDeltaUsec: 5000, tightDeltaUsec: 900000, cappedCpuM: 150, capped: true, samePod: true, podTight: 'app-x-1', tightUsageMs: 9000 },
    oom: { restartsBefore: 0, restartsAfter: 1, reason: 'app-x:OOMKilled', reasons: ['app-x:OOMKilled'] },
    restored: true,
  });
  assert.equal(noCoverage.status, 'inconclusive', 'halved utilization without proven constant-load generation never passes');
  assert.equal(noCoverage.checks[0].pass, false);
});

test('signals grader separates equal-RPS cost', async () => {
  const { gradeSignals } = await import('./grade.mjs');
  const good = gradeSignals({
    cpuPhase: { offered: 120, completed: 120, p50: 210, avgCpuM: 640, cpuSamples: 4, hotUsageMs: 18500, hotPod: 'app-x-1' },
    ioPhase: { offered: 120, completed: 120, p50: 810, avgCpuM: 90, cpuSamples: 4, hotUsageMs: 900, hotPod: 'app-x-1' },
    rps: 6,
  });
  assert.equal(good.status, 'pass');
  const missing = gradeSignals({
    cpuPhase: { offered: 120, completed: 120, p50: 210, avgCpuM: null, cpuSamples: 0, hotUsageMs: null, hotPod: null },
    ioPhase: { offered: 120, completed: 120, p50: 810, avgCpuM: null, cpuSamples: 0, hotUsageMs: null, hotPod: null },
    rps: 6,
  });
  assert.equal(missing.status, 'inconclusive', 'missing CPU samples stay inconclusive, never zero-filled');
});

test('downstream grader reports the strict-vs-aggressive verdict honestly', async () => {
  const { gradeDownstream } = await import('./grade.mjs');
  const mk = (timely, shed) => ({ offered: 360, timelyRps: timely, shed, timeouts: 10, p95: 1500, attemptsAvg: 1, attemptsMax: 1, attemptsN: 20 });
  const win = gradeDownstream({
    phaseA: mk(4, 60), phaseB: mk(9, 20),
    depA: { cpuM: 950, inflight: 6 }, depB: { cpuM: 940, inflight: 4 }, restored: true,
  });
  assert.equal(win.status, 'pass');
  assert.match(win.evidence.verdict, /strict policy raised/);
  const thin = gradeDownstream({
    phaseA: { ...mk(4, 60), offered: 50 }, phaseB: mk(9, 20),
    depA: { cpuM: 950, inflight: 6 }, depB: { cpuM: 940, inflight: 4 }, restored: true,
  });
  assert.equal(thin.status, 'inconclusive', 'thin phases cannot compare policies');
});

test('disruptions grader needs API refusal plus budget status', async () => {
  const { gradeDisruptions } = await import('./grade.mjs');
  const good = gradeDisruptions({
    evict1: { pod: 'a', allowed: true, status: 0, detail: 'evicted' },
    evict2: { pod: 'b', allowed: false, status: 1, detail: 'TooManyRequests: budget', pdbAllowed: 0 },
    deleted: { pod: 'c', deleted: true },
    traffic: { total: 400, failures: 3, kinds: ['ECONNRESET'] },
    pdbRemoved: true,
  });
  assert.equal(good.status, 'pass');
  const luck = gradeDisruptions({
    evict1: { pod: 'a', allowed: true, status: 0, detail: 'evicted' },
    evict2: { pod: 'b', allowed: true, status: 0, detail: 'evicted' },
    deleted: { pod: 'c', deleted: true },
    traffic: { total: 400, failures: 0, kinds: [] },
    pdbRemoved: true,
  });
  assert.equal(luck.status, 'inconclusive', 'two allowed evictions prove no block');
});

test('gateway grader needs independent timestamps and categories', async () => {
  const { gradeGateway } = await import('./grade.mjs');
  const good = gradeGateway({ drain: {
    podDeleteAt: 't0', endpointGoneAt: 't1', requestEndAt: 't2',
    ordering: 'endpoint removal preceded response completion by 1.2s',
    slowOutcome: { complete: true, ms: 8100, status: 200, error: null },
    bg: { ok: 100, http502: 2, transport: 0 },
  } });
  assert.equal(good.status, 'pass');
  const timeless = gradeGateway({ drain: { podDeleteAt: 't0', endpointGoneAt: null, requestEndAt: 't2', ordering: null, slowOutcome: { complete: true }, bg: { ok: 1, http502: 0, transport: 0 } } });
  assert.equal(timeless.status, 'inconclusive');
});

test('capstone fails openly on breach, requires an allowed disruption', async () => {
  const { gradeCapstone } = await import('./grade.mjs');
  const mk = (p95, err) => ({ p95, errorPct: err, samples: 300, offered: 400 });
  const held = gradeCapstone({
    objective: { sloP95Ms: 800, sloErrorPct: 5, mix: 'balanced' },
    phases: { burst: mk(300, 1), rollout: mk(400, 0), disruption: { ...mk(500, 2), eviction: 'allowed' }, recovery: mk(100, 0) },
  });
  assert.equal(held.status, 'pass');
  const breached = gradeCapstone({
    objective: { sloP95Ms: 800, sloErrorPct: 5, mix: 'balanced' },
    phases: { burst: mk(300, 1), rollout: mk(400, 0), disruption: { ...mk(500, 2), eviction: 'allowed' }, recovery: mk(2500, 1) },
  });
  assert.equal(breached.status, 'fail');
  assert.ok(breached.checks.some((c) => /BREACHED/.test(c.label)));
  const refused = gradeCapstone({
    objective: { sloP95Ms: 800, sloErrorPct: 5, mix: 'balanced' },
    phases: { burst: mk(300, 1), rollout: mk(400, 0), disruption: { ...mk(500, 2), eviction: 'refused' }, recovery: mk(100, 0) },
  });
  assert.equal(refused.status, 'inconclusive', 'refused disruption cannot pass the guarded-disruption phase');
});
