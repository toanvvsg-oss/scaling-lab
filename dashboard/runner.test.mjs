import test from 'node:test';
import assert from 'node:assert/strict';
import { requireAutoscaler, startRequest, traffic, createStopScope, drainBg, evaluateWindowCoverage, settleOwnedWork, hasUnsettled, awaitUnsettled, CLEANUP_UNSETTLED, validateCapstoneOptions, pacedRequests, summarizePaced } from './runner.mjs';
import { cpuHpaManifest } from './runs.mjs';
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

test('wedged request settles by its absolute deadline, not the socket timeout', async (t) => {
  const server = http.createServer(() => { /* never responds: wedged backend */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const started = Date.now();
  const request = startRequest('/hang', false, `http://127.0.0.1:${server.address().port}`, { deadlineMs: 300 });
  const headers = await request.headers;
  assert.match(headers.error || '', /deadline exceeded/);
  const outcome = await request.done;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.complete, false);
  assert.match(outcome.error || '', /deadline exceeded/);
  assert.ok(Date.now() - started < 5000, 'settled by the deadline instead of hanging');
});

test('dribbling response cannot defeat the absolute deadline', async (t) => {
  // 1 byte every 100ms keeps the socket "active" so the 30s socket inactivity
  // timeout never fires; without the absolute deadline this hangs forever.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    const timer = setInterval(() => { try { res.write('x'); } catch { /* client gone */ } }, 100);
    req.on('close', () => clearInterval(timer));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const started = Date.now();
  const outcome = await startRequest('/dribble', false, `http://127.0.0.1:${server.address().port}`, { deadlineMs: 400 }).done;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.complete, false);
  assert.match(outcome.error || '', /deadline exceeded/);
  assert.ok(Date.now() - started < 5000, 'dribble defeated by the deadline');
});

test('queued request settles by its deadline without an assigned socket', async (t) => {
  // maxSockets=1 with a held first request: the second request waits in the
  // agent queue with no socket, where destroy() alone never settles it. The
  // deadline must settle both promises explicitly, independently of release.
  const server = http.createServer(() => { /* never responds: holds the only socket */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  let firstSettled = false;
  const first = startRequest('/hold', agent, baseUrl, { deadlineMs: 1500 });
  first.done.then(() => { firstSettled = true; });
  await new Promise((r) => setTimeout(r, 100)); // first occupies the only socket
  const secondStarted = Date.now();
  const second = startRequest('/queued', agent, baseUrl, { deadlineMs: 300 });
  const secondHeaders = await second.headers;
  assert.match(secondHeaders.error || '', /deadline exceeded/);
  const secondOutcome = await second.done;
  assert.equal(secondOutcome.ok, false);
  assert.equal(secondOutcome.complete, false);
  assert.match(secondOutcome.error || '', /deadline exceeded/);
  const secondMs = Date.now() - secondStarted;
  assert.ok(secondMs < 1000, `queued request settled by its deadline (${secondMs}ms), not by socket release`);
  assert.equal(firstSettled, false, 'second settled independently while the first still held its socket');
  const firstOutcome = await first.done;
  assert.match(firstOutcome.error || '', /deadline exceeded/);
});

test('traffic cancellation settles stragglers and releases sockets', async (t) => {
  let inFlight = 0;
  const server = http.createServer((req, res) => {
    inFlight += 1;
    setTimeout(() => { inFlight -= 1; res.end('ok'); }, 400);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let cancel = false;
  const outcomes = [];
  const started = Date.now();
  const p = traffic(30000, '/slowish', (type) => { outcomes.push(type); }, 50, 1, baseUrl, () => cancel);
  await new Promise((r) => setTimeout(r, 150));
  cancel = true;
  await assert.rejects(p, /cancelled by End lesson/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10000, `cancel drained stragglers promptly (${elapsed}ms), not after the full window`);
  assert.ok(outcomes.length > 0, 'in-flight stragglers settled and reported instead of being abandoned');
  assert.equal(inFlight, 0, 'no server-side handler left hanging');
  let conns = -1;
  for (let i = 0; i < 20 && conns !== 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
    await new Promise((resolve) => server.getConnections((error, n) => { conns = error ? -1 : n; resolve(); }));
  }
  assert.equal(conns, 0, 'agent sockets released after cancellation');
});

test('stop scope merges external and internal cancellation; drainBg awaits settlement', async () => {
  let external = false;
  const scope = createStopScope(() => external);
  assert.equal(scope.cancelFn(), false);
  scope.requestStop();
  assert.equal(scope.cancelFn(), true);
  const scope2 = createStopScope(() => external);
  assert.equal(scope2.cancelFn(), false);
  external = true;
  assert.equal(scope2.cancelFn(), true);
  assert.equal(await drainBg([], null), true);
  assert.equal(await drainBg([Promise.resolve(1)], null, 1000), true);
  const started = Date.now();
  assert.equal(await drainBg([new Promise(() => {})], null, 200), false);
  assert.ok(Date.now() - started < 5000, 'drain timeout is bounded');
  if (typeof process._getActiveHandles === 'function') {
    const timers = () => process._getActiveHandles().filter((h) => h?.constructor?.name === 'Timeout').length;
    const before = timers();
    assert.equal(await drainBg([(async () => { await new Promise((r) => setTimeout(r, 20)); return 1; })()], null, 5000), true);
    assert.equal(timers(), before, 'drain timeout timer cleared on the fast path');
  }
});

test('window coverage measures generation, not delayed completion', () => {
  const win = { winStart: 10000, winEnd: 30000, intervalMs: 200 };
  const offers = [];
  for (let t = 10000; t <= 30000; t += 200) offers.push(t);
  const successes = offers.filter((_, i) => i % 5 === 0);
  const healthy = evaluateWindowCoverage({ offers, successes, failures: [], generatorStoppedAt: 31000, ...win });
  assert.equal(healthy.ok, true, `healthy generation spans the window: ${healthy.reasons.join(';')}`);
  assert.equal(healthy.detail.offered, 101);
  // Generation ends mid-window while delayed completions still land inside
  // it: offers stop, completions continue — must NOT count as coverage.
  const drained = evaluateWindowCoverage({
    offers: offers.filter((t) => t < 18000),
    successes: successes.filter((t) => t >= 10000),
    failures: [],
    generatorStoppedAt: 18000,
    ...win,
  });
  assert.equal(drained.ok, false, 'drain completions after generation stopped prove nothing');
  assert.ok(drained.reasons.some((r) => /generation ended/.test(r)));
  // Failures-only window with live generation: no useful work proven.
  const failing = evaluateWindowCoverage({
    offers, successes: [], failures: offers.filter((_, i) => i % 5 === 0),
    generatorStoppedAt: 31000, ...win,
  });
  assert.equal(failing.ok, false, 'failures-only window cannot prove unchanged useful work');
  // Stalled generator: offers present but nothing near the window end.
  const stalled = evaluateWindowCoverage({
    offers: offers.filter((t) => t < 15000), successes: successes.filter((t) => t < 15000),
    failures: [], generatorStoppedAt: 31000, ...win,
  });
  assert.equal(stalled.ok, false, 'generation must span the window through its end');
});

test('ownership handoff rethrows the original on drained work, retains on undrained', async () => {
  const events = [];
  const emit = (t, d) => events.push([t, d]);
  const scope = createStopScope(null);
  // Drained: original error (even CANCELLED) propagates unchanged.
  const original = Object.assign(new Error('cancelled by End lesson'), { code: 'CANCELLED' });
  await assert.rejects(settleOwnedWork(scope, [(async () => 1)()], emit, 'test work', original), (e) => e === original);
  assert.equal(hasUnsettled('nonexistent'), false);
  // Undrained: distinct cleanup failure wins over the cancelled original.
  let release;
  const gate = new Promise((r) => { release = r; });
  const scope2 = createStopScope(null);
  let retainedKey = null;
  const pending = settleOwnedWork(scope2, [gate], emit, 'test work', original, 200);
  await assert.rejects(pending, (e) => {
    assert.equal(e.code, CLEANUP_UNSETTLED);
    assert.ok(e.cleanupKey, 'cleanup failure carries the registry key');
    assert.equal(e.cause, original, 'original preserved as cause, not hidden');
    retainedKey = e.cleanupKey;
    assert.equal(hasUnsettled(retainedKey), true, 'outstanding work registered for retry');
    return true;
  });
  // Same work resolves later: retry rejoins the SAME promises and completes.
  release();
  assert.equal(await awaitUnsettled(retainedKey, 2000), true);
  assert.equal(hasUnsettled(retainedKey), false, 'settled work unregisters');
  assert.equal(await awaitUnsettled(retainedKey, 100), true, 'rejoin after settlement is a fast no-op');
});

test('capstone options accept bounded HPA settings with a rationale', () => {
  const out = validateCapstoneOptions({ minReplicas: 1, maxReplicas: 8, cpuTarget: 30, rationale: 'Warm headroom for the burst within laptop bounds.' });
  assert.equal(out.minReplicas, 1);
  assert.equal(out.maxReplicas, 8);
  assert.equal(out.cpuTarget, 30);
  assert.match(out.rationale, /headroom/);
  const manifest = cpuHpaManifest('scaling-run-abcdef12', out);
  assert.equal(manifest.spec.minReplicas, 1);
  assert.equal(manifest.spec.maxReplicas, 8);
  assert.equal(manifest.spec.metrics[0].resource.target.averageUtilization, 30);
});

test('capstone options reject out-of-range bounds, max<min, and rationale problems', () => {
  const base = { rationale: 'Holds headroom while capping laptop load.' };
  assert.throws(() => validateCapstoneOptions({ ...base, minReplicas: 0 }), /minReplicas/);
  assert.throws(() => validateCapstoneOptions({ ...base, minReplicas: 6 }), /minReplicas/);
  assert.throws(() => validateCapstoneOptions({ ...base, maxReplicas: 0 }), /maxReplicas/);
  assert.throws(() => validateCapstoneOptions({ ...base, maxReplicas: 9 }), /maxReplicas/);
  assert.throws(() => validateCapstoneOptions({ ...base, minReplicas: 4, maxReplicas: 2 }), /greater than or equal/);
  assert.throws(() => validateCapstoneOptions({ ...base, cpuTarget: 20 }), /cpuTarget/);
  assert.throws(() => validateCapstoneOptions({ ...base, cpuTarget: 95 }), /cpuTarget/);
  assert.throws(() => validateCapstoneOptions({ minReplicas: 2, maxReplicas: 5, cpuTarget: 60 }), /rationale/);
  assert.throws(() => validateCapstoneOptions({ ...base, rationale: '   ' }), /rationale/);
  assert.throws(() => validateCapstoneOptions({ ...base, rationale: 'x'.repeat(501) }), /at most 500/);
});

test('paced traffic records dropped offers and settles every started request', async () => {
  const server = http.createServer((req, res) => setTimeout(() => res.end('ok'), 100));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const raw = await pacedRequests(`http://127.0.0.1:${server.address().port}`, '/fast', 40, 250, 1000, () => {}, { maxInflight: 1 });
    const summary = summarizePaced(raw, 500);
    assert.ok(raw.dropped > 0);
    assert.equal(raw.offered, raw.started + raw.dropped);
    assert.equal(raw.started, raw.completed + raw.failed);
    assert.equal(summary.started, raw.started);
    assert.equal(summary.missedSlots, raw.missedSlots);
  } finally { await new Promise((r) => server.close(r)); }
});

test('late generator slots are counted rather than replayed as a clean burst', async () => {
  const server = http.createServer((req, res) => { res.statusCode = 500; res.end('failed'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const raw = await pacedRequests(`http://127.0.0.1:${server.address().port}`, '/fast', 100, 250, 1000, () => {
      const until = Date.now() + 30;
      while (Date.now() < until) { /* simulate a delayed event-loop observer */ }
    });
    assert.ok(raw.missedSlots > 0);
    assert.ok(raw.dropped >= raw.missedSlots);
    assert.equal(raw.offered, raw.started + raw.dropped);
    assert.equal(raw.started, raw.completed + raw.failed);
  } finally { await new Promise((r) => server.close(r)); }
});
