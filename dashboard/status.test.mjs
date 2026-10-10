import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyResult, recordStatus, emptyStats, summarizeStats, hintFor } from './status.mjs';

test('every counted response uses a render-free http-result event: 100 successes + 1 failure totals 101 despite 1-in-10 trace sampling', () => {
  const stats = emptyStats();
  // Simulate a load loop over 101 responses: each emits one 'http-result'
  // for accounting; only every 10th success emits an additional trace
  // 'sample', and the single failure emits a trace 'request'. Stats fold
  // ONLY http-result events.
  let traceSamples = 0;
  for (let i = 0; i < 100; i++) {
    recordStatus(stats, { ok: true, complete: true, status: 200, pod: 'app-x-1', requestId: `r-${i}`, ms: 5 });
    if ((i + 1) % 10 === 0) traceSamples += 1;
  }
  recordStatus(stats, { ok: false, complete: true, status: 500, pod: 'app-x-2', requestId: 'r-fail', ms: 6 });
  assert.equal(traceSamples, 10);
  assert.equal(stats.total, 101);
  assert.equal(stats.ok2xx, 100);
  assert.equal(stats.http5xx, 1);
  const s = summarizeStats(stats);
  assert.equal(s.errors, 1);
  assert.equal(s.errorRate, 1 / 101);
});

test('byStatus counts 200 and every actual completed code, not only errors', () => {
  const stats = emptyStats();
  recordStatus(stats, { ok: true, complete: true, status: 200, pod: 'p', requestId: 'a' });
  recordStatus(stats, { ok: false, complete: true, status: 404, pod: 'p', requestId: 'b' });
  recordStatus(stats, { ok: false, complete: true, status: 502, requestId: 'c' });
  assert.equal(stats.byStatus['200'], 1);
  assert.equal(stats.byStatus['404'], 1);
  assert.equal(stats.byStatus['502'], 1);
  assert.equal(stats.total, 3);
});

test('partial 200-then-reset is transport/incomplete but preserves headers-seen status and identity', () => {
  const r = { ok: false, complete: false, error: 'ECONNRESET', pod: 'app-x-1', requestId: 'req-9', headersSeen: true, partial: true, observedStatus: 200, status: null, ms: 120 };
  const c = classifyResult(r);
  assert.equal(c.kind, 'transport');
  assert.equal(c.status, null);
  assert.equal(c.observedStatus, 200);
  assert.equal(c.partial, true);
  const hint = hintFor(c, r);
  assert.match(hint, /Headers were seen \(HTTP 200/);
  assert.doesNotMatch(hint, /No HTTP status was observed/);
  const stats = emptyStats();
  const entry = recordStatus(stats, r);
  assert.equal(stats.transport, 1);
  assert.equal(stats.partial, 1);
  assert.equal(entry.observedStatus, 200);
  assert.equal(entry.requestId, 'req-9');
});

test('transport with no headers seen says no HTTP status was observed and invents no status', () => {
  const c = classifyResult({ ok: false, complete: false, error: 'ECONNREFUSED' });
  assert.equal(c.kind, 'transport');
  assert.equal(c.status, null);
  assert.equal(c.observedStatus, null);
  assert.match(hintFor(c, {}), /No HTTP status was observed/);
});

test('successful graceful completion carries status and counts 2xx exactly once', () => {
  // Guided slow-end/stream-end completions must carry status/requestId;
  // a single record call counts one 2xx.
  const done = { ok: true, complete: true, status: 200, pod: 'app-x-1', requestId: 'slow-1', ms: 8010 };
  const c = classifyResult(done);
  assert.equal(c.kind, 'ok');
  assert.equal(c.status, 200);
  const stats = emptyStats();
  recordStatus(stats, done);
  assert.equal(stats.total, 1);
  assert.equal(stats.ok2xx, 1);
  assert.equal(stats.byStatus['200'], 1);
});

test('completed demo 404/500 and edge 502 are http-error, never transport', () => {
  assert.equal(classifyResult({ ok: false, complete: true, status: 404, pod: 'p', requestId: 'x' }).kind, 'http-error');
  assert.equal(classifyResult({ ok: false, complete: true, status: 500, pod: 'p', requestId: 'x' }).kind, 'http-error');
  const edge = classifyResult({ ok: false, complete: true, status: 502, requestId: 'x' });
  assert.equal(edge.kind, 'http-error');
  assert.equal(edge.hasPod, false);
});

test('3xx redirects are retained separately and never count as errors', () => {
  for (const status of [301, 304]) {
    const c = classifyResult({ ok: false, complete: true, status, pod: 'p', requestId: 'x' });
    assert.equal(c.kind, 'redirect');
    assert.equal(c.statusClass, '3xx');
  }
  const stats = emptyStats();
  recordStatus(stats, { ok: true, complete: true, status: 200, pod: 'p', requestId: 'a' });
  recordStatus(stats, { ok: false, complete: true, status: 301, pod: 'p', requestId: 'b' });
  recordStatus(stats, { ok: false, complete: true, status: 500, pod: 'p', requestId: 'c' });
  recordStatus(stats, { ok: false, complete: false, error: 'ECONNRESET', requestId: 'd' });
  assert.equal(stats.total, 4);
  assert.equal(stats.http3xx, 1);
  assert.equal(stats.byStatus['301'], 1);
  assert.equal(stats.recentErrors.length, 2, 'only the 500 and the transport reset are recent errors');
  const s = summarizeStats(stats);
  assert.equal(s.errors, 1, 'error numerator is 4xx+5xx only');
  assert.equal(s.errorRate, 1 / 4);
  assert.equal(s.transportRate, 1 / 4);
});

test('502/504 hint lists possible causes without asserting a proven root cause', () => {
  const hint = hintFor(classifyResult({ ok: false, complete: true, status: 502, requestId: 'r-1' }), { requestId: 'r-1' });
  assert.match(hint, /Upstream\/proxy-observed 502/);
  assert.match(hint, /[Pp]ossible/);
  assert.doesNotMatch(hint, /could not reach/);
  assert.match(hint, /r-1/);
});

test('timeout after headers says the response did not finish', () => {
  const after = hintFor(
    classifyResult({ ok: false, complete: false, error: 'ETIMEDOUT', pod: 'p', requestId: 'r-2', headersSeen: true, partial: true, observedStatus: 200, status: null }),
    { pod: 'p', requestId: 'r-2' },
  );
  assert.match(after, /did not finish/);
  assert.doesNotMatch(after, /with no response/);
  const before = hintFor(classifyResult({ ok: false, complete: false, error: 'ETIMEDOUT' }), {});
  assert.match(before, /with no response/);
});

test('server folds only render-free http-result events: trace stays bounded while totals count every response', async () => {
  const { createApp, prodDeps } = await import('./server.mjs');
  const { runs, archives } = await import('./runs.mjs');
  runs.clear(); archives.clear();
  // Fake load session: start() emits 100 ok http-results + 10 trace samples
  // + one failed http-result + its trace request, mirroring LoadSession.
  const fakeSession = (emit) => ({
    active: false,
    state() { return { active: this.active, profile: 'steady', total: 101, failures: 1, offeredLastSecond: 0, achievedLastSecond: 0 }; },
    async start() {
      this.active = true;
      for (let i = 0; i < 100; i++) {
        emit('http-result', { ok: true, complete: true, status: 200, pod: 'app-x-1', requestId: `r-${i}`, ms: 4 });
        if ((i + 1) % 10 === 0) emit('sample', { pod: 'app-x-1', ok: true, complete: true, status: 200, ms: 4, requestId: `r-${i}` });
      }
      emit('http-result', { ok: false, complete: true, status: 500, pod: 'app-x-2', requestId: 'r-fail', ms: 5 });
      emit('request', { pod: 'app-x-2', ok: false, complete: true, status: 500, requestId: 'r-fail', ms: 5 });
      return this.state();
    },
    async stop() { this.active = false; return this.state(); },
    increase() { return this.state(); },
    decrease() { return this.state(); },
  });
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'lab-status-'));
  const app = createApp({
    clusterState: async () => ({ connected: true, pods: [], endpoints: [] }),
    runScenario: async () => ({ status: 'pass', checks: [], evidence: {} }),
    loadFactory: (emit) => fakeSession(emit),
    // Never touch the real cluster: stub re-adoption (the live scaling-lab
    // cluster may hold retained runs; adopting them would spawn real
    // kubectl port-forward children that outlive the test).
    runsApi: { ...prodDeps.runsApi, adoptOrphanRuns: async () => [] },
    promQuery: async () => ({ value: null, at: null, stale: true }),
    queryRunSamples: async () => ({ total: null, at: null, upAllOne: false, evaluatedAt: null, stale: true }),
    resetApi: { validateResetTarget: (t) => t, runReset: async () => ({ ok: true, readyPods: 2 }) },
    runAction: async () => ({}),
    resultsDir: dir,
    enableSampler: false,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  try {
    await app.boot();
    const post = await fetch(`http://127.0.0.1:${port}/api/load`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start', profile: 'steady' }),
    });
    assert.equal(post.status, 200);
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.equal(state.statusStats.total, 101);
    assert.equal(state.statusStats.ok2xx, 100);
    assert.equal(state.statusStats.http5xx, 1);
    assert.equal(state.statusStats.byStatus['200'], 100);
    // Accounting never enters the trace history: only the 10 sampled
    // successes, the 1 failure request, and load markers are stored.
    const types = state.events.map((e) => e.type);
    assert.equal(types.filter((t) => t === 'http-result').length, 0);
    assert.equal(types.filter((t) => t === 'sample').length, 10);
    assert.ok(state.events.length < 40);
  } finally {
    await new Promise((r) => app.server.close(r));
    runs.clear(); archives.clear();
  }
});

test('scenario pass marker leaves HTTP totals unchanged', async (t) => {
  const { createApp } = await import('./server.mjs');
  const R = await import('./runs.mjs');
  const { makeFakeCluster } = await import('./test-fake.mjs');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  R.runs.clear(); R.archives.clear();
  const fake = makeFakeCluster();
  const dir = mkdtempSync(join(tmpdir(), 'lab-marker-'));
  const runsApi = {
    runs: R.runs, archives: R.archives,
    activeRuns: R.activeRuns, MAX_ACTIVE_RUNS: R.MAX_ACTIVE_RUNS,
    RUN_LESSONS: R.RUN_LESSONS, validateRunId: R.validateRunId,
    describeRun: R.describeRun,
    beginRun: (lesson, emit) => R.beginRun(lesson, emit, fake.deps),
    finishRun: (run, emit) => R.finishRun(run, emit, fake.deps),
    cleanupRun: (id) => R.cleanupRun(id, dir, fake.deps),
    runClusterState: (id) => R.runClusterState(id, fake.deps),
    buildArchive: R.buildArchive,
    adoptOrphanRuns: () => R.adoptOrphanRuns(fake.deps),
  };
  const idleSession = () => ({
    active: false,
    state() { return { active: false, profile: null, total: 0, failures: 0, offeredLastSecond: 0, achievedLastSecond: 0 }; },
    async start() { this.active = true; return this.state(); },
    async stop() { this.active = false; return this.state(); },
    increase() { return this.state(); },
    decrease() { return this.state(); },
  });
  const app = createApp({
    clusterState: async () => ({ connected: true, pods: [], endpoints: [] }),
    // Scenario emits 3 accounted responses, then the server appends its
    // own 'result' completion marker ({status: 'pass'}) like production.
    runScenario: async (id, opts, emit) => {
      for (let i = 0; i < 3; i++) {
        emit('http-result', { ok: true, complete: true, status: 200, pod: 'app-x-1', requestId: `m-${i}`, ms: 2 });
      }
      return { status: 'pass', checks: [], evidence: {} };
    },
    loadFactory: () => idleSession(),
    runsApi,
    promQuery: async () => ({ value: 1, at: new Date().toISOString(), stale: false }),
    queryRunSamples: async () => ({ total: 0, at: null, upAllOne: true, evaluatedAt: null, stale: true }),
    counterSelForRun: (id) => `c-${id}`,
    upSelForRun: (id) => `u-${id}`,
    resetApi: { validateResetTarget: (x) => x, runReset: async () => ({}) },
    runAction: async () => ({}),
    resultsDir: dir,
    enableSampler: false,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => app.server.close(r)));
  t.after(() => { R.runs.clear(); R.archives.clear(); });
  const port = app.server.address().port;
  const api = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  await app.boot();
  const created = await api('POST', '/api/runs', { lesson: 'connections' });
  assert.equal(created.status, 202);
  const id = created.body.id;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    const s = await api('GET', '/api/runs');
    ready = s.body.some((x) => x.id === id && x.status === 'ready');
    if (!ready) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(ready, 'run became ready');
  const started = await api('POST', `/api/runs/${id}/run`, { id: 'connections' });
  assert.equal(started.status, 202);
  let done = false;
  for (let i = 0; i < 100 && !done; i++) {
    const g = await api('GET', `/api/runs/${id}`);
    done = g.body.resultStatus === 'pass';
    if (!done) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(done, 'scenario completed with pass');
  const detail = (await api('GET', `/api/runs/${id}`)).body;
  // Only the 3 accounted responses count; the pass marker adds none.
  assert.equal(detail.statusStats.total, 3);
  assert.equal(detail.statusStats.ok2xx, 3);
  const marker = detail.events.filter((e) => e.type === 'result');
  assert.equal(marker.length, 1);
  assert.equal(marker[0].data.status, 'pass');
  assert.equal(detail.events.filter((e) => e.type === 'http-result').length, 0);
});
