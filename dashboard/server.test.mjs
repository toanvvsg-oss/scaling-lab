import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createApp, EXPLANATIONS, prodDeps } from './server.mjs';
import * as R from './runs.mjs';
import { makeFakeCluster } from './test-fake.mjs';
import { cleanupUnsettledError, awaitUnsettled } from './runner.mjs';

test('production runsApi wires every method the routes call', () => {
  const api = prodDeps.runsApi;
  for (const k of ['beginRun', 'finishRun', 'createRun', 'cleanupRun', 'runClusterState', 'buildArchive', 'adoptOrphanRuns', 'describeRun', 'validateRunId', 'activeRuns', 'checkLessonPrereqs']) {
    assert.equal(typeof api[k], 'function', `prodDeps.runsApi.${k}`);
  }
  assert.equal(api.beginRun, R.beginRun);
  assert.equal(api.finishRun, R.finishRun);
  assert.equal(api.cleanupRun, R.cleanupRun);
  assert.ok(api.runs instanceof Map && api.archives instanceof Map);
  assert.equal(api.MAX_ACTIVE_RUNS, R.MAX_ACTIVE_RUNS);
  assert.equal(api.RUN_LESSONS, R.RUN_LESSONS);
});

function fakeSession() {
  return {
    active: false, profile: null,
    state() { return { active: this.active, profile: this.profile, targetRps: 0, total: 0, failures: 0, offeredLastSecond: 0, achievedLastSecond: 0 }; },
    async start(profile) { this.active = true; this.profile = profile; return this.state(); },
    async stop() { this.active = false; return this.state(); },
    increase() { return this.state(); },
    decrease() { return this.state(); },
  };
}

async function bootTestServer(overrides = {}) {
  const fake = makeFakeCluster();
  const dir = mkdtempSync(join(tmpdir(), 'lab-srv-'));
  const { runsApi: runsApiOverrides, ...rest } = overrides;
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
    checkLessonPrereqs: async () => ({ ok: true, checks: [{ name: 'cluster', ok: true }], missing: [] }),
    ...runsApiOverrides,
  };
  const app = createApp({
    clusterState: async () => ({ connected: true, pods: [], endpoints: [] }),
    runScenario: async () => ({ status: 'pass', checks: [], evidence: {} }),
    loadFactory: () => fakeSession(),
    runsApi,
    promQuery: async () => ({ value: 1, at: new Date().toISOString(), stale: false }),
    queryRunSamples: async () => ({ total: 100, at: new Date().toISOString(), stalestAt: null, upAllOne: true, evaluatedAt: new Date().toISOString(), stale: false }),
    counterSelForRun: (id) => `counter-for-${id}`,
    upSelForRun: (id) => `up-for-${id}`,
    resetApi: { validateResetTarget: (t) => t, runReset: async () => ({ ok: true, readyPods: 2 }) },
    resultsDir: dir,
    enableSampler: false,
    ...rest,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const api = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { api, ...app, fake, dir };
}

async function readyIds(api, n, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const s = await api('GET', '/api/runs');
    const ready = s.body.filter((x) => x.status === 'ready').map((x) => x.id);
    if (ready.length >= n) return ready;
    await new Promise((x) => setTimeout(x, 50));
  }
  throw new Error('runs did not become ready in time');
}

test('boot gate, single allocation, and lesson start conflicts', async (t) => {
  R.runs.clear(); R.archives.clear();
  const ctx = await bootTestServer();
  t.after(() => new Promise((r) => ctx.server.close(r)));
  const waitLesson = async (pred, timeoutMs = 15000) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const s = await ctx.api('GET', '/api/lesson');
      if (pred(s.body)) return s.body;
      await new Promise((x) => setTimeout(x, 100));
    }
    throw new Error('lesson flow did not settle in time');
  };
  let r = await ctx.api('POST', '/api/lesson/start', { lesson: 'connections' });
  assert.equal(r.status, 503);
  await ctx.boot();
  r = await ctx.api('POST', '/api/lesson/start', { lesson: 'nope' });
  assert.equal(r.status, 400);
  r = await ctx.api('POST', '/api/lesson/start', { lesson: 'connections' });
  assert.equal(r.status, 202);
  const flow = await waitLesson((b) => b.active?.status === 'ready');
  assert.equal(flow.active.lesson, 'connections');
  assert.match(flow.active.runId, /^[a-z0-9]{8}$/);
  assert.ok(flow.active.stages.some((s) => s.stage === 'check-prerequisites'), 'prerequisite stage reported');
  assert.ok(flow.active.stages.some((s) => s.stage === 'ready'), 'ready stage reported');
  // Second start and direct creation both conflict while active.
  r = await ctx.api('POST', '/api/lesson/start', { lesson: 'rollout' });
  assert.equal(r.status, 409);
  r = await ctx.api('POST', '/api/runs', { lesson: 'rollout' });
  assert.equal(r.status, 409);
  // Practice routes address the active run; foreign mutating calls are refused.
  r = await ctx.api('POST', `/api/runs/${flow.active.runId}/load`, { action: 'start', profile: 'steady' });
  assert.equal(r.status, 200);
  // End stops traffic, archives honestly, and frees the slot.
  r = await ctx.api('POST', '/api/lesson/end');
  assert.equal(r.status, 202);
  const done = await waitLesson((b) => b.active === null && b.history.length === 1, 30000);
  assert.equal(done.history[0].lesson, 'connections');
  assert.equal(done.history[0].ended, 'incomplete', 'ended without a scenario: incomplete, never a pass');
  r = await ctx.api('POST', '/api/lesson/start', { lesson: 'rollout' });
  assert.equal(r.status, 202, 'slot freed after end');
  await waitLesson((b) => b.active?.status === 'ready');
  await ctx.api('POST', '/api/lesson/end');
  await waitLesson((b) => b.active === null, 30000);
});

test('conflicting load-vs-scenario actions are rejected', async (t) => {
  R.runs.clear(); R.archives.clear();
  const ctx = await bootTestServer();
  t.after(() => new Promise((r) => ctx.server.close(r)));
  await ctx.boot();
  const { body } = await ctx.api('POST', '/api/runs', { lesson: 'prometheus' });
  await readyIds(ctx.api, 1);
  // start manual load, then the one-click scenario must conflict
  let r = await ctx.api('POST', `/api/runs/${body.id}/load`, { action: 'start', profile: 'steady' });
  assert.equal(r.status, 200);
  r = await ctx.api('POST', `/api/runs/${body.id}/run`, { id: 'prometheus' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Manual load is running/);
  r = await ctx.api('POST', `/api/runs/${body.id}/load`, { action: 'stop' });
  assert.equal(r.status, 200);
  // a second concurrent load start is rejected; scenario now proceeds
  r = await ctx.api('POST', `/api/runs/${body.id}/load`, { action: 'start', profile: 'steady' });
  assert.equal(r.status, 200);
  r = await ctx.api('POST', `/api/runs/${body.id}/load`, { action: 'start', profile: 'steady' });
  assert.equal(r.status, 409);
});

test('cleanup failure keeps state for retry, then deletes', async (t) => {
  R.runs.clear(); R.archives.clear();
  const ctx = await bootTestServer();
  t.after(() => new Promise((r) => ctx.server.close(r)));
  await ctx.boot();
  const { body } = await ctx.api('POST', '/api/runs', { lesson: 'prometheus' });
  await readyIds(ctx.api, 1);
  // inject namespace-deletion failure into the fake
  const origExec = ctx.fake.deps.exec;
  ctx.fake.deps.exec = async (args) => {
    if (args.join(' ').includes('delete namespace')) throw new Error('injected delete failure');
    return origExec(args);
  };
  let r = await ctx.api('DELETE', `/api/runs/${body.id}`);
  assert.equal(r.status, 202);
  for (let i = 0; i < 50; i++) {
    const g = await ctx.api('GET', `/api/runs/${body.id}`);
    if (g.body.status === 'cleanup-failed') break;
    await new Promise((x) => setTimeout(x, 50));
  }
  r = await ctx.api('GET', `/api/runs/${body.id}`);
  assert.equal(r.body.status, 'cleanup-failed');
  assert.match(r.body.error, /injected delete failure/);
  ctx.fake.deps.exec = origExec;
  r = await ctx.api('DELETE', `/api/runs/${body.id}`);
  assert.equal(r.status, 202);
  for (let i = 0; i < 50; i++) {
    const g = await ctx.api('GET', `/api/runs/${body.id}`);
    if (g.body.status === 'deleted') break;
    await new Promise((x) => setTimeout(x, 50));
  }
  r = await ctx.api('GET', '/api/evidence', undefined);
  assert.equal(r.status, 200);
});

test('repeated DELETE reports the current cleanup without starting it again', async (t) => {
  R.runs.clear(); R.archives.clear();
  const ctx = await bootTestServer();
  t.after(() => new Promise((r) => ctx.server.close(r)));
  await ctx.boot();
  const { body } = await ctx.api('POST', '/api/runs', { lesson: 'connections' });
  await readyIds(ctx.api, 1);
  const origExec = ctx.fake.deps.exec;
  let releaseDelete;
  let deletions = 0;
  ctx.fake.deps.exec = async (args) => {
    if (args.includes('delete') && args.includes('namespace')) {
      deletions++;
      await new Promise((resolve) => { releaseDelete = resolve; });
    }
    return origExec(args);
  };
  assert.equal((await ctx.api('DELETE', `/api/runs/${body.id}`)).status, 202);
  for (let i = 0; i < 100 && !releaseDelete; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(releaseDelete);
  const repeated = await ctx.api('DELETE', `/api/runs/${body.id}`);
  assert.equal(repeated.status, 202);
  assert.equal(repeated.body.status, 'deleting');
  assert.equal(repeated.body.cleanup.stage, 'delete-namespace');
  assert.equal(deletions, 1);
  releaseDelete();
  for (let i = 0; i < 100 && R.runs.get(body.id).status !== 'deleted'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(R.runs.get(body.id).status, 'deleted');
  assert.equal((await ctx.api('DELETE', `/api/runs/${body.id}`)).status, 200);
  assert.equal(deletions, 1);
});

test('browser app access is scoped, streams immediately, and rejects arbitrary targets', async (t) => {
  R.runs.clear(); R.archives.clear();
  const ctx = await bootTestServer();
  t.after(() => new Promise((r) => ctx.server.close(r)));
  await ctx.boot();
  const { body } = await ctx.api('POST', '/api/runs', { lesson: 'connections' });
  await readyIds(ctx.api, 1);
  const requests = [];
  const upstream = http.createServer((req, res) => {
    requests.push({ path: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/plain', 'x-pod': 'test-app-pod', 'set-cookie': 'private=test' });
    if (req.url === '/stream') {
      res.write('first tick\n');
      setTimeout(() => res.end('last tick\n'), 250);
    } else res.end(req.url);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => upstream.close(r)));
  R.runs.get(body.id).forwardPort = upstream.address().port;
  const base = `http://127.0.0.1:${ctx.server.address().port}/app/${body.id}`;
  assert.equal((await ctx.api('GET', `/api/runs/${body.id}`)).body.appUrl, `/app/${body.id}/fast`);
  const response = await fetch(base + '/fast', { headers: { cookie: 'session=secret', authorization: 'Bearer secret' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-pod'), 'test-app-pod');
  assert.equal(response.headers.get('x-scaling-lab-run'), body.id);
  assert.equal(response.headers.get('x-scaling-lab-namespace'), `scaling-run-${body.id}`);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(await response.text(), '/fast');
  assert.equal(requests[0].headers.cookie, undefined);
  assert.equal(requests[0].headers.authorization, undefined);
  const stream = await fetch(base + '/stream');
  const reader = stream.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first tick\n');
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'last tick\n');
  assert.equal((await reader.read()).done, true);
  const slow = await fetch(base + '/slow?ms=8000');
  assert.equal(await slow.text(), '/slow?ms=8000');
  const before = requests.length;
  for (const [path, status] of [
    ['/metrics?url=http://example.com', 400], ['/slow?ms=99999', 400],
    ['/slow?ms=1&ms=2', 400], ['/slow?ms=-1', 400], ['/lifecycle', 404], ['/https://example.com', 404],
  ]) assert.equal((await fetch(base + path)).status, status, path);
  assert.equal((await fetch(base + '/fast', { method: 'POST' })).status, 405);
  assert.equal((await fetch(`http://127.0.0.1:${ctx.server.address().port}/app/deadbeef/fast`)).status, 404);
  assert.equal(requests.length, before, 'rejected requests never reach an upstream');
  R.runs.get(body.id).status = 'deleted';
  assert.equal((await fetch(base + '/fast')).status, 410);
});

test('Grafana defaults to in-flight requests for shutdown and validates monitoring views', async (t) => {
  R.runs.clear(); R.archives.clear();
  let lookups = 0;
  const ctx = await bootTestServer({ grafanaApi: { status: async () => { lookups++; return { available: true, baseUrl: 'http://127.0.0.1:3003' }; }, close() {} } });
  t.after(() => new Promise((r) => ctx.server.close(r)));
  await ctx.boot();
  const { body } = await ctx.api('POST', '/api/runs', { lesson: 'shutdown' });
  await readyIds(ctx.api, 1);
  const initial = await ctx.api('GET', `/api/grafana?run=${body.id}`);
  assert.equal(initial.body.view, 'activity');
  assert.equal(new URL(initial.body.embedUrl).searchParams.get('panelId'), '11');
  assert.equal(new URL(initial.body.embedUrl).searchParams.get('var-run'), body.id);
  const counters = await ctx.api('GET', `/api/grafana?run=${body.id}&view=responses`);
  assert.equal(new URL(counters.body.embedUrl).searchParams.get('panelId'), '15');
  const rate = await ctx.api('GET', `/api/grafana?run=${body.id}&view=rate`);
  assert.equal(new URL(rate.body.embedUrl).searchParams.get('panelId'), '7');
  const before = lookups;
  assert.equal((await ctx.api('GET', `/api/grafana?run=${body.id}&view=arbitrary`)).status, 400);
  assert.equal((await ctx.api('GET', '/api/grafana?run=deadbeef')).status, 404);
  assert.equal(lookups, before, 'invalid inputs do not start a route');
});

test('predictions are scoped per run and lesson with observation gating', async (t) => {
  R.runs.clear(); R.archives.clear();
  const ctx = await bootTestServer();
  t.after(() => new Promise((r) => ctx.server.close(r)));
  await ctx.boot();
  const a = (await ctx.api('POST', '/api/runs', { lesson: 'prometheus' })).body;
  const b = (await ctx.api('POST', '/api/runs', { lesson: 'autoscale' })).body;
  await readyIds(ctx.api, 2);
  let r = await ctx.api('POST', '/api/predict', { guess: 'up', run: a.id });
  assert.equal(r.status, 200);
  r = await ctx.api('POST', '/api/predict', { guess: 'down', run: b.id });
  assert.equal(r.status, 200);
  // no observations yet: reveal must ask the learner to observe first
  r = await ctx.api('POST', '/api/reveal', { run: a.id });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Observe after predicting/);
  // record an observation, then explanations differ by lesson
  await ctx.api('POST', `/api/runs/${a.id}/load`, { action: 'start', profile: 'steady' });
  await ctx.api('POST', `/api/runs/${a.id}/load`, { action: 'stop' });
  r = await ctx.api('POST', '/api/reveal', { run: a.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.explanation, EXPLANATIONS.prometheus);
  await ctx.api('POST', `/api/runs/${b.id}/load`, { action: 'start', profile: 'steady' });
  await ctx.api('POST', `/api/runs/${b.id}/load`, { action: 'stop' });
  r = await ctx.api('POST', '/api/reveal', { run: b.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.explanation, EXPLANATIONS.autoscale);
  assert.notEqual(EXPLANATIONS.autoscale, EXPLANATIONS.prometheus);
  r = await ctx.api('POST', '/api/predict', { guess: 'up', run: 'deadbeef' });
  assert.equal(r.status, 404);
  r = await ctx.api('POST', '/api/predict', { guess: 'sideways' });
  assert.equal(r.status, 400);
});

test('malformed ids and archive discovery at boot', async (t) => {
  R.runs.clear(); R.archives.clear();
  const ctx = await bootTestServer();
  t.after(() => new Promise((r) => ctx.server.close(r)));
  writeFileSync(join(ctx.dir, 'archive-aaaabbbb.json'), JSON.stringify({ run: 'aaaabbbb', lesson: 'prometheus', timeline: { points: [], milestones: [] }, events: [] }));
  writeFileSync(join(ctx.dir, 'archive-evil.json'), JSON.stringify({ run: 'evil' }));
  await ctx.boot();
  const s = await ctx.api('GET', '/api/state');
  assert.ok(s.body.archivedRuns.includes('aaaabbbb'));
  assert.ok(!s.body.archivedRuns.includes('evil'));
  const r = await ctx.api('GET', '/api/evidence?run=aaaabbbb');
  assert.equal(r.status, 200);
  assert.equal(r.body.run, 'aaaabbbb');
  const bad = await ctx.api('GET', '/api/runs/SCALING-LAB/timeline');
  assert.equal(bad.status, 400);
  const missing = await ctx.api('GET', '/api/runs/a1b2c3d4/timeline');
  assert.equal(missing.status, 404);
});

test('guided-action conflicts: action/load/scenario/cleanup serialize', async (t) => {
  R.runs.clear(); R.archives.clear();
  const ctx = await bootTestServer();
  t.after(() => new Promise((r) => ctx.server.close(r)));
  await ctx.boot();
  // NOTE: bootTestServer uses the real runAction; override per-test via a
  // deferred implementation through a dedicated app below.
  const { createApp: mk } = await import('./server.mjs');
  const blocked = makeFakeCluster();
  let releaseAction;
  const actionGate = new Promise((r) => { releaseAction = r; });
  const actionCalls = [];
  const store2 = { runs: new Map(), archives: new Map() };
  const runsApi2 = {
    runs: store2.runs, archives: store2.archives,
    activeRuns() { return [...store2.runs.values()].filter((r) => !['deleted', 'failed'].includes(r.status)); },
    MAX_ACTIVE_RUNS: R.MAX_ACTIVE_RUNS,
    RUN_LESSONS: new Set(['connections', 'rollout']),
    validateRunId: R.validateRunId,
    describeRun: R.describeRun,
    beginRun: (lesson, emit) => {
      const id = (0xb0000000 + store2.runs.size).toString(16);
      const run = { id, ns: `scaling-run-${id}`, lesson, status: 'ready', createdAt: new Date().toISOString(), error: null, steps: [], events: [], rev: 0, timeline: { points: [], milestones: [] }, result: null, load: null, forward: null, forwardPort: 18989, prev: null, scenarioRunning: false, actionRunning: false, pendingLong: null, actions: 0 };
      store2.runs.set(id, run);
      return run;
    },
    finishRun: async (run) => run,
    cleanupRun: async (id) => { const r = store2.runs.get(id); r.status = 'deleted'; return r; },
    runClusterState: async () => ({ connected: true, pods: [], endpoints: [], hpa: null }),
    buildArchive: (r) => ({ run: r.id }),
    adoptOrphanRuns: async () => [],
  };
  const app2 = mk({
    clusterState: async () => ({ connected: true, pods: [], endpoints: [] }),
    runScenario: async () => ({ status: 'pass', checks: [], evidence: {} }),
    loadFactory: () => (() => {
      const s = { active: false, state() { return { active: this.active }; }, async start() { this.active = true; return this.state(); }, async stop() { this.active = false; return this.state(); }, increase() { return this.state(); }, decrease() { return this.state(); } };
      return s;
    })(),
    runsApi: runsApi2,
    promQuery: async () => ({ value: 1, at: new Date().toISOString(), stale: false }),
    queryRunSamples: async () => ({ total: 0, at: null, upAllOne: true, evaluatedAt: null, stale: true }),
    counterSelForRun: (id) => `c-${id}`,
    upSelForRun: (id) => `u-${id}`,
    rateQueryForRun: (id) => `r-${id}`,
    upQueryForRun: (id) => `cu-${id}`,
    resetApi: { validateResetTarget: (x) => x, runReset: async () => ({}) },
    runAction: async (run, action) => { actionCalls.push(action); await actionGate; return { action }; },
    resultsDir: ctx.dir,
    enableSampler: false,
  });
  await new Promise((r) => app2.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => app2.server.close(r)));
  const port = app2.server.address().port;
  const api = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  await app2.boot();
  const c = (await api('POST', '/api/runs', { lesson: 'connections' })).body;
  const id = c.id;
  // attach a load session like wireRunLoad would
  runsApi2.runs.get(id).load = (() => {
    const s = { active: false, state() { return { active: this.active }; }, async start() { this.active = true; return this.state(); }, async stop() { this.active = false; return this.state(); }, increase() { return this.state(); }, decrease() { return this.state(); } };
    return s;
  })();
  const first = api('POST', `/api/runs/${id}/actions`, { action: 'reuse-batch' });
  await new Promise((r) => setTimeout(r, 50));
  let r = await api('POST', `/api/runs/${id}/actions`, { action: 'fresh-batch' });
  assert.equal(r.status, 409);
  r = await api('DELETE', `/api/runs/${id}`);
  assert.equal(r.status, 409, 'cleanup preflight rejects while an action runs');
  r = await api('POST', `/api/runs/${id}/run`, { id: 'connections' });
  assert.equal(r.status, 409);
  r = await api('POST', `/api/runs/${id}/load`, { action: 'start', profile: 'steady' });
  assert.equal(r.status, 409);
  releaseAction();
  assert.equal((await first).status, 200);
  assert.deepEqual(actionCalls, ['reuse-batch']);
  // load active: plain actions rejected, rollout trio proceeds
  await api('POST', `/api/runs/${id}/load`, { action: 'start', profile: 'steady' });
  r = await api('POST', `/api/runs/${id}/actions`, { action: 'reuse-batch' });
  assert.equal(r.status, 409);
  // pendingLong blocks load start / scenario / cleanup
  store2.runs.get(id).pendingLong = { pod: 'p' };
  r = await api('POST', `/api/runs/${id}/load`, { action: 'stop' });
  assert.equal(r.status, 200, 'stop stays available');
  r = await api('POST', `/api/runs/${id}/load`, { action: 'start', profile: 'steady' });
  assert.equal(r.status, 409);
  r = await api('POST', `/api/runs/${id}/run`, { id: 'connections' });
  assert.equal(r.status, 409);
  r = await api('DELETE', `/api/runs/${id}`);
  assert.equal(r.status, 409);
});

test('lesson start reports missing prerequisites with guidance, provisions nothing', async (t) => {
  R.runs.clear(); R.archives.clear();
  const ctx = await bootTestServer({
    runsApi: { checkLessonPrereqs: async () => ({ ok: false, checks: [{ name: 'metrics', ok: false }], missing: [{ name: 'metrics', guidance: 'Run: make hpa-up' }] }) },
  });
  t.after(() => new Promise((r) => ctx.server.close(r)));
  await ctx.boot();
  const r = await ctx.api('POST', '/api/lesson/start', { lesson: 'autoscale' });
  assert.equal(r.status, 409);
  assert.match(r.body.missing[0].guidance, /make hpa-up/);
  assert.equal(R.runs.size, 0, 'no namespace provisioned when prerequisites are missing');
  const flow = await ctx.api('GET', '/api/lesson');
  assert.equal(flow.body.active, null);
});

test('end during a scenario cancels it and archives an honest cancelled outcome', async (t) => {
  R.runs.clear(); R.archives.clear();
  let observedCancel = false;
  const ctx = await bootTestServer({
    runScenario: async (id, opts) => {
      for (let i = 0; i < 600; i++) {
        if (opts.cancel && opts.cancel()) { observedCancel = true; break; }
        await new Promise((x) => setTimeout(x, 100));
      }
      const err = new Error('cancelled by End lesson');
      err.code = 'CANCELLED';
      throw err;
    },
  });
  t.after(() => new Promise((r) => ctx.server.close(r)));
  await ctx.boot();
  await ctx.api('POST', '/api/lesson/start', { lesson: 'connections' });
  const waitLesson = async (pred, timeoutMs = 20000) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const s = await ctx.api('GET', '/api/lesson');
      if (pred(s.body)) return s.body;
      await new Promise((x) => setTimeout(x, 100));
    }
    throw new Error('lesson flow did not settle in time');
  };
  const flow = await waitLesson((b) => b.active?.status === 'ready');
  const run = await ctx.api('POST', `/api/runs/${flow.active.runId}/run`, { id: 'connections' });
  assert.equal(run.status, 202);
  await new Promise((x) => setTimeout(x, 500));
  const end = await ctx.api('POST', '/api/lesson/end');
  assert.equal(end.status, 202);
  const done = await waitLesson((b) => b.active === null && b.history.length === 1, 30000);
  assert.ok(observedCancel, 'scenario observed the cancellation token');
  assert.equal(done.history[0].ended, 'cancelled');
  const ev = await ctx.api('GET', `/api/evidence?run=${flow.active.runId}`);
  assert.equal(ev.body.result?.status, 'cancelled', 'cancelled outcome recorded, never a pass');
});

test('failed cleanup retains the allocation and retry succeeds', async (t) => {
  R.runs.clear(); R.archives.clear();
  const ctx = await bootTestServer();
  t.after(() => new Promise((r) => ctx.server.close(r)));
  await ctx.boot();
  await ctx.api('POST', '/api/lesson/start', { lesson: 'connections' });
  const waitLesson = async (pred, timeoutMs = 20000) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const s = await ctx.api('GET', '/api/lesson');
      if (pred(s.body)) return s.body;
      await new Promise((x) => setTimeout(x, 100));
    }
    throw new Error('lesson flow did not settle in time');
  };
  const flow = await waitLesson((b) => b.active?.status === 'ready');
  // Sabotage namespace deletion once: cleanup fails and the slot is retained.
  const realDelete = ctx.fake.deps.exec;
  let failOnce = true;
  ctx.fake.deps.exec = async (args) => {
    if (failOnce && args.join(' ').includes('delete namespace')) { failOnce = false; throw new Error('injected delete failure'); }
    return realDelete(args);
  };
  await ctx.api('POST', '/api/lesson/end');
  const stuck = await waitLesson((b) => b.active?.status === 'cleanup-failed', 30000);
  assert.match(stuck.active.error, /injected delete failure/);
  // A second start is refused while cleanup-failed holds the allocation.
  const retry = await ctx.api('POST', '/api/lesson/start', { lesson: 'rollout' });
  assert.equal(retry.status, 409);
  // Retry End: this time deletion succeeds and the slot frees.
  await ctx.api('POST', '/api/lesson/end');
  await waitLesson((b) => b.active === null && b.history.length === 1, 30000);
  void flow;
});

test('inherited environments resolve explicitly without silent deletes', async (t) => {
  R.runs.clear(); R.archives.clear();
  const mk = (lesson) => ({ id: lesson === 'a' ? 'aaaabbbb' : 'ccccdddd', ns: `scaling-run-${lesson === 'a' ? 'aaaabbbb' : 'ccccdddd'}`, lesson: 'connections', status: 'ready', createdAt: new Date().toISOString() });
  const ctx = await bootTestServer({
    runsApi: {
    adoptOrphanRuns: async () => {
      const a = mk('a'); const b = mk('b');
      for (const r of [a, b]) {
        Object.assign(r, { steps: [], events: [], timeline: { points: [], milestones: [] }, result: null, load: null, forward: null, forwardPort: null, prev: null });
        R.runs.set(r.id, r);
      }
      return [R.runs.get('aaaabbbb'), R.runs.get('ccccdddd')];
    },
    },
  });
  t.after(() => new Promise((r) => ctx.server.close(r)));
  await ctx.boot();
  let flow = await ctx.api('GET', '/api/lesson');
  assert.equal(flow.body.migration.runs.length, 2);
  assert.equal(flow.body.active, null);
  // Start is refused until migration resolves.
  let r = await ctx.api('POST', '/api/lesson/start', { lesson: 'rollout' });
  assert.equal(r.status, 409);
  // Resume is refused while two remain; end one explicitly (evidence kept).
  r = await ctx.api('POST', '/api/lesson/migrate', { action: 'resume', id: 'aaaabbbb' });
  assert.equal(r.status, 409);
  r = await ctx.api('POST', '/api/lesson/migrate', { action: 'end', id: 'aaaabbbb' });
  assert.equal(r.status, 200);
  assert.equal(r.body.migration.runs.length, 1);
  r = await ctx.api('POST', '/api/lesson/migrate', { action: 'resume', id: 'ccccdddd' });
  assert.equal(r.status, 200);
  flow = await ctx.api('GET', '/api/lesson');
  assert.equal(flow.body.migration, null);
  assert.equal(flow.body.active.runId, 'ccccdddd');
  assert.equal(flow.body.active.status, 'ready');
});

test('concurrent starts grant exactly one allocation (TOCTOU guard)', async (t) => {
  R.runs.clear(); R.archives.clear();
  // Slow prereqs widen the race window: both requests must still serialize.
  const ctx = await bootTestServer({
    runsApi: { checkLessonPrereqs: async () => { await new Promise((r) => setTimeout(r, 200)); return { ok: true, checks: [], missing: [] }; } },
  });
  t.after(() => new Promise((r) => ctx.server.close(r)));
  await ctx.boot();
  const [a, b] = await Promise.all([
    ctx.api('POST', '/api/lesson/start', { lesson: 'connections' }),
    ctx.api('POST', '/api/lesson/start', { lesson: 'rollout' }),
  ]);
  const statuses = [a.status, b.status].sort().join(',');
  assert.equal(statuses, '202,409', `exactly one winner, got ${a.status}/${b.status}`);
  const waitLesson = async (pred, timeoutMs = 20000) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const s = await ctx.api('GET', '/api/lesson');
      if (pred(s.body)) return s.body;
      await new Promise((x) => setTimeout(x, 100));
    }
    throw new Error('lesson flow did not settle in time');
  };
  const flow = await waitLesson((x) => x.active?.status === 'ready');
  assert.ok(flow.active.runId);
  const live = [...R.runs.values()].filter((r) => !['deleted', 'failed'].includes(r.status));
  assert.equal(live.length, 1, 'the loser provisioned nothing');
  await ctx.api('POST', '/api/lesson/end');
  await waitLesson((x) => x.active === null, 30000);
});

test('unsettled drain retains the allocation, blocks new work, and rejoins the same work on retry', async (t) => {
  R.runs.clear(); R.archives.clear();
  let calls = 0;
  const seenKeys = [];
  let gateResolve;
  const gate = new Promise((r) => { gateResolve = r; });
  const flakyScenario = async (id, opts, emit) => {
    calls += 1;
    if (calls === 1) {
      // Mimic a production catch that cannot drain: distinct cleanup failure
      // carrying registry ownership of the outstanding promise.
      emit('note', { text: 'first attempt leaves background work outstanding' });
      throw cleanupUnsettledError('fake background work', [gate]);
    }
    return { status: 'pass', checks: [], evidence: {} };
  };
  const ctx = await bootTestServer({
    runScenario: flakyScenario,
    // Short bound keeps the test fast; production uses 120s.
    awaitScenarioCleanup: (key) => { seenKeys.push(key); return awaitUnsettled(key, 300); },
  });
  t.after(() => new Promise((r) => ctx.server.close(r)));
  t.after(() => { R.runs.clear(); R.archives.clear(); });
  await ctx.boot();
  const waitLesson = async (pred, timeoutMs = 20000) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const s = await ctx.api('GET', '/api/lesson');
      if (pred(s.body)) return s.body;
      await new Promise((x) => setTimeout(x, 100));
    }
    throw new Error('lesson flow did not settle in time');
  };
  const waitRun = async (runId, pred, timeoutMs = 10000) => {
    const until = Date.now() + timeoutMs;
    let run;
    while (Date.now() < until) {
      run = (await ctx.api('GET', `/api/runs/${runId}`)).body;
      if (pred(run)) return run;
      await new Promise((x) => setTimeout(x, 100));
    }
    throw new Error('run did not settle in time');
  };
  let r = await ctx.api('POST', '/api/lesson/start', { lesson: 'connections' });
  assert.equal(r.status, 202);
  const flow = await waitLesson((b) => b.active?.status === 'ready');
  const runId = flow.active.runId;
  const runNs = (await ctx.api('GET', `/api/runs/${runId}`)).body.namespace;
  assert.ok(ctx.fake.namespaces.has(runNs), 'namespace provisioned');

  // First attempt fails with retained cleanup ownership.
  r = await ctx.api('POST', `/api/runs/${runId}/run`, { id: 'connections' });
  assert.equal(r.status, 202);
  const retained = await waitRun(runId, (x) => Boolean(x.cleanupPending || x.error));
  assert.ok(retained.cleanupPending?.key, 'outstanding-work ownership retained on the run');
  assert.equal(retained.scenarioRunning, true, 'still marked running while retained');
  assert.ok(ctx.fake.namespaces.has(runNs), 'namespace retained, not deleted');
  assert.ok((await ctx.api('GET', '/api/lesson')).body.active, 'allocation retained');
  assert.equal((await ctx.api('GET', '/api/lesson')).body.history.length, 0, 'nothing archived');

  // Retry rejoins the SAME work instead of starting over; other work refuses.
  r = await ctx.api('POST', `/api/runs/${runId}/run`, { id: 'connections' });
  assert.equal(r.status, 202, 'retry accepted to rejoin retained work');
  await new Promise((x) => setTimeout(x, 700)); // 300ms join bound lapses while the gate is shut
  assert.equal(calls, 1, 'no fresh scenario started while work is unsettled');
  const still = await waitRun(runId, (x) => /still unsettled/.test(x.error || ''));
  assert.ok(still.cleanupPending, 'retention survives a failed rejoin');
  r = await ctx.api('POST', `/api/runs/${runId}/actions`, { action: 'q-start' });
  assert.equal(r.status, 409, 'actions blocked while retained');
  r = await ctx.api('POST', `/api/runs/${runId}/load`, { action: 'start' });
  assert.equal(r.status, 409, 'new load blocked while retained');
  r = await ctx.api('DELETE', `/api/runs/${runId}`);
  assert.equal(r.status, 409, 'namespace deletion blocked while retained');
  r = await ctx.api('POST', '/api/lesson/start', { lesson: 'rollout' });
  assert.equal(r.status, 409, 'switch/start blocked while retained');

  // End while unsettled retains everything and names the same work.
  r = await ctx.api('POST', '/api/lesson/end');
  assert.equal(r.status, 202);
  const failedEnd = await waitLesson((b) => b.active?.status === 'cleanup-failed');
  assert.equal(failedEnd.active.status, 'cleanup-failed');
  assert.ok(ctx.fake.namespaces.has(runNs), 'namespace still retained after failed End');
  assert.ok(seenKeys.includes(retained.cleanupPending.key), 'End awaited the SAME registered work');

  // Resolve the work: retry rejoins and runs, then End archives with no lates.
  gateResolve();
  r = await ctx.api('POST', `/api/runs/${runId}/run`, { id: 'connections' });
  assert.equal(r.status, 202);
  const passed = await waitRun(runId, (x) => x.resultStatus === 'pass');
  assert.equal(calls, 2, 'retry ran the scenario only after the same work settled');
  assert.equal(passed.cleanupPending, null, 'retention cleared after settlement');
  r = await ctx.api('POST', '/api/lesson/end');
  assert.equal(r.status, 202);
  await waitLesson((b) => b.active === null, 30000);
  assert.ok(!ctx.fake.namespaces.has(runNs), 'namespace deleted only after settlement');
  assert.ok(R.archives.has(runId), 'evidence archived');
  const archivedEvents = R.archives.get(runId).events?.length ?? -1;
  await new Promise((x) => setTimeout(x, 300));
  assert.equal(R.archives.get(runId).events?.length ?? -2, archivedEvents, 'no late events after archival');
});

test('M3 learning records: predict/explain/self-review persist with bounds and reveal never submits', async (t) => {
  R.runs.clear(); R.archives.clear();
  const ctx = await bootTestServer();
  t.after(() => new Promise((r) => ctx.server.close(r)));
  await ctx.boot();
  const created = (await ctx.api('POST', '/api/runs', { lesson: 'capacity' })).body;
  await readyIds(ctx.api, 1);
  const id = created.id;

  // Predict before any experiment: prior=true.
  let r = await ctx.api('POST', '/api/predict', { run: id, guess: 'same', reasoning: 'flat goodput' });
  assert.equal(r.status, 200);
  assert.equal(r.body.prior, true);
  assert.equal(r.body.prediction.answer, 'same');

  // Lesson mismatch rejected.
  r = await ctx.api('POST', '/api/predict', { run: id, lesson: 'downstream', guess: 'up' });
  assert.equal(r.status, 400);

  // Reasoning bound enforced.
  r = await ctx.api('POST', '/api/predict', { run: id, guess: 'up', reasoning: 'x'.repeat(2001) });
  assert.equal(r.status, 400);

  // Explicit skip on a second run records skipped.
  const c2 = (await ctx.api('POST', '/api/runs', { lesson: 'capacity' })).body;
  await readyIds(ctx.api, 2);
  r = await ctx.api('POST', '/api/predict', { run: c2.id, skip: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.prediction.status, 'skipped');

  // Predict after observation is kept but not labeled prior.
  await ctx.api('POST', `/api/runs/${id}/load`, { action: 'start', profile: 'cheap' });
  await ctx.api('POST', `/api/runs/${id}/load`, { action: 'stop' });
  r = await ctx.api('POST', '/api/predict', { run: id, guess: 'up', reasoning: 'after' });
  assert.equal(r.status, 200);
  assert.equal(r.body.prior, false);
  // New observation after the second prediction re-opens reveal.
  await ctx.api('POST', `/api/runs/${id}/load`, { action: 'start', profile: 'cheap' });
  await ctx.api('POST', `/api/runs/${id}/load`, { action: 'stop' });

  // Reveal works after observation but does NOT submit an explanation.
  r = await ctx.api('POST', '/api/reveal', { run: id });
  assert.equal(r.status, 200);
  assert.ok(r.body.explanation);
  let d = (await ctx.api('GET', `/api/runs/${id}`)).body;
  assert.equal(d.explanation, null);
  assert.ok(d.modelRevealed);
  assert.equal(d.prediction.answer, 'up');
  assert.equal(d.prediction.prior, false);

  // Self-review gated before explanation.
  r = await ctx.api('POST', '/api/self-review', { run: id });
  assert.equal(r.status, 400);

  // Explanation requires all four fields within bounds.
  r = await ctx.api('POST', '/api/explain', { run: id, observation: 'o', evidence: 'e' });
  assert.equal(r.status, 400);
  r = await ctx.api('POST', '/api/explain', { run: id, observation: 'o', evidence: 'e', interpretation: 'i', nextAction: 'n' });
  assert.equal(r.status, 200);
  assert.equal(r.body.revision, 1);

  // Revision preserves the initial response.
  r = await ctx.api('POST', '/api/explain', { run: id, observation: 'o2', evidence: 'e2', interpretation: 'i2', nextAction: 'n2' });
  assert.equal(r.status, 200);
  assert.equal(r.body.revision, 2);
  d = (await ctx.api('GET', `/api/runs/${id}`)).body;
  assert.equal(d.explanation.revision, 2);
  assert.equal(d.explanation.revisions.length, 2);
  assert.equal(d.explanation.revisions[0].observation, 'o');
  assert.equal(d.rubric.length, 4);

  // Self-review returns the model explanation + rubric, idempotent.
  r = await ctx.api('POST', '/api/self-review', { run: id });
  assert.equal(r.status, 200);
  assert.equal(r.body.modelExplanation, EXPLANATIONS.capacity);
  assert.equal(r.body.rubric.length, 4);
  const firstAt = r.body.at;
  r = await ctx.api('POST', '/api/self-review', { run: id });
  assert.equal(r.status, 200);
  assert.equal(r.body.at, firstAt);
  assert.equal(r.body.idempotent, true);

  // Skipped explanation also unlocks self-review.
  r = await ctx.api('POST', '/api/explain', { run: c2.id, skip: true });
  assert.equal(r.status, 200);
  r = await ctx.api('POST', '/api/self-review', { run: c2.id });
  assert.equal(r.status, 200);

  // Persistence: evidence export carries the learning record.
  const ev = (await ctx.api('GET', `/api/evidence?run=${id}`)).body;
  assert.equal(ev.learning.prediction.answer, 'up');
  assert.equal(ev.learning.explanation.status, 'submitted');
  assert.equal(ev.learning.selfReview.done, true);

  // Legacy archive without learning renders as unavailable.
  R.archives.set('ffffffff', { run: 'ffffffff', lesson: 'capacity', archivedAt: new Date().toISOString(), status: 'pass', ended: 'completed', result: { status: 'pass' } });
  const hist = (await ctx.api('GET', '/api/lesson')).body.history;
  const legacy = hist.find((h) => h.run === 'ffffffff');
  assert.equal(legacy.prediction, null);
  assert.equal(legacy.explanation, null);
});

test('Q5 minimal: hint levels and diagnosis report persist on the learning record', async (t) => {
  R.runs.clear(); R.archives.clear();
  const ctx = await bootTestServer();
  t.after(() => new Promise((r) => ctx.server.close(r)));
  await ctx.boot();
  const created = (await ctx.api('POST', '/api/runs', { lesson: 'capacity' })).body;
  await readyIds(ctx.api, 1);
  const id = created.id;

  let r = await ctx.api('POST', '/api/hint', { run: id, level: 9 });
  assert.equal(r.status, 400);
  r = await ctx.api('POST', '/api/hint', { run: id, level: 1 });
  assert.equal(r.status, 200);
  assert.ok(r.body.text);
  r = await ctx.api('POST', '/api/hint', { run: id, level: 3 });
  assert.equal(r.status, 200);
  assert.equal(r.body.hintsUsed, 2);

  // Diagnosis rejects unknown variants and overlong text.
  r = await ctx.api('POST', '/api/diagnosis', { run: id, variant: { kind: 'nope' } });
  assert.equal(r.status, 400);
  r = await ctx.api('POST', '/api/diagnosis', { run: id, initialDiagnosis: 'x'.repeat(2001) });
  assert.equal(r.status, 400);
  r = await ctx.api('POST', '/api/diagnosis', { run: id });
  assert.equal(r.status, 400);

  const variant = { kind: 'capacity-challenge', config: { work: 'expensive', sloP95Ms: 500, sloErrorPct: 5 } };
  r = await ctx.api('POST', '/api/diagnosis', { run: id, initialDiagnosis: '15 RPS/pod generator-clean, +1 headroom', variant });
  assert.equal(r.status, 200);
  assert.equal(r.body.diagnosis.initialDiagnosis.length > 0, true);
  assert.equal(r.body.diagnosis.variant.kind, 'capacity-challenge');
  // Partial update preserves hints and earlier fields.
  r = await ctx.api('POST', '/api/diagnosis', { run: id, change: 'hold 5 pods for 60 peak RPS', outcome: 'pending measurement' });
  assert.equal(r.status, 200);
  assert.equal(r.body.diagnosis.change.length > 0, true);

  const d = (await ctx.api('GET', `/api/runs/${id}`)).body;
  assert.equal(d.learning.diagnosis.hintsUsed.length, 2);
  assert.equal(d.learning.diagnosis.initialDiagnosis.length > 0, true);
  assert.equal(d.learningStatus.diagnosis, 'submitted');
  const ev = (await ctx.api('GET', `/api/evidence?run=${id}`)).body;
  assert.equal(ev.learning.diagnosis.variant.kind, 'capacity-challenge');
});

test('attempts retain initial revisions, reset learning on rerun, and reject ended writes', async (t) => {
  R.runs.clear(); R.archives.clear();
  const ctx = await bootTestServer();
  t.after(() => new Promise((r) => ctx.server.close(r)));
  await ctx.boot();
  const id = (await ctx.api('POST', '/api/runs', { lesson: 'capacity' })).body.id;
  await readyIds(ctx.api, 1);
  await ctx.api('POST', '/api/predict', { run: id, guess: 'up', reasoning: 'first prediction' });
  const fields = { run: id, evidence: 'e', interpretation: 'i', nextAction: 'n' };
  for (let i = 1; i <= 12; i++) {
    assert.equal((await ctx.api('POST', '/api/explain', { ...fields, observation: `response ${i}` })).status, 200);
  }
  let d = (await ctx.api('GET', `/api/runs/${id}`)).body;
  assert.equal(d.explanation.revisions[0].observation, 'response 1');
  assert.equal(d.explanation.revisions.at(-1).observation, 'response 12');
  await ctx.api('POST', '/api/self-review', { run: id });
  await ctx.api('POST', `/api/runs/${id}/run`, { id: 'capacity' });
  while (R.runs.get(id).scenarioRunning) await new Promise((r) => setTimeout(r, 10));
  assert.equal((await ctx.api('POST', '/api/attempt', { run: id })).status, 200);
  d = (await ctx.api('GET', `/api/runs/${id}`)).body;
  assert.equal(d.explanation, null);
  assert.equal(d.selfReview, null);
  assert.equal(d.modelRevealed, null);
  const prediction = await ctx.api('POST', '/api/predict', { run: id, guess: 'same' });
  assert.equal(prediction.body.prior, true);
  await ctx.api('POST', `/api/runs/${id}/run`, { id: 'capacity' });
  while (R.runs.get(id).scenarioRunning) await new Promise((r) => setTimeout(r, 10));
  const ev = (await ctx.api('GET', `/api/evidence?run=${id}`)).body;
  assert.equal(ev.attempts.length, 1);
  assert.equal(ev.attempts[0].learning.explanation.revisions[0].observation, 'response 1');
  assert.equal(ev.learning.prediction.answer, 'same');
  await R.cleanupRun(id, ctx.dir, ctx.fake.deps);
  for (const [path, body] of [
    ['/api/predict', { guess: 'up' }], ['/api/explain', { ...fields, observation: 'after end' }],
    ['/api/self-review', {}], ['/api/hint', { level: 1 }], ['/api/diagnosis', { outcome: 'after end' }], ['/api/attempt', {}],
  ]) assert.equal((await ctx.api('POST', path, { ...body, run: id })).status, 409, path);
});

test('boot recovers active learning from disk without creating another environment', async (t) => {
  R.runs.clear(); R.archives.clear();
  const ctx = await bootTestServer();
  await ctx.boot();
  const id = (await ctx.api('POST', '/api/runs', { lesson: 'capacity' })).body.id;
  await readyIds(ctx.api, 1);
  await ctx.api('POST', '/api/predict', { run: id, guess: 'up', reasoning: 'survives restart' });
  await ctx.api('POST', '/api/explain', { run: id, observation: 'saved work', evidence: 'e', interpretation: 'i', nextAction: 'n' });
  await new Promise((r) => ctx.server.close(r));
  R.runs.clear();
  const second = await bootTestServer({ resultsDir: ctx.dir, runsApi: { adoptOrphanRuns: () => R.adoptOrphanRuns(ctx.fake.deps) } });
  t.after(() => new Promise((r) => second.server.close(r)));
  await second.boot();
  const detail = (await second.api('GET', `/api/runs/${id}`)).body;
  assert.equal(detail.prediction.reasoning, 'survives restart');
  assert.equal(detail.explanation.observation, 'saved work');
  assert.equal((await second.api('GET', '/api/lesson')).body.active.runId, id);
  assert.equal(R.runs.size, 1);
});
