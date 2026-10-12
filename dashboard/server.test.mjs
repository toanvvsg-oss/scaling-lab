import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createApp, EXPLANATIONS, prodDeps } from './server.mjs';
import * as R from './runs.mjs';
import { makeFakeCluster } from './test-fake.mjs';

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
