import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, EXPLANATIONS, prodDeps } from './server.mjs';
import * as R from './runs.mjs';
import { makeFakeCluster } from './test-fake.mjs';

test('production runsApi wires every method the routes call', () => {
  const api = prodDeps.runsApi;
  for (const k of ['beginRun', 'finishRun', 'createRun', 'cleanupRun', 'runClusterState', 'buildArchive', 'adoptOrphanRuns', 'describeRun', 'validateRunId', 'activeRuns']) {
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

async function bootTestServer() {
  const fake = makeFakeCluster();
  const dir = mkdtempSync(join(tmpdir(), 'lab-srv-'));
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

test('boot gate, creation correlation, and limit', async (t) => {
  R.runs.clear(); R.archives.clear();
  const ctx = await bootTestServer();
  t.after(() => new Promise((r) => ctx.server.close(r)));
  let r = await ctx.api('POST', '/api/runs', { lesson: 'prometheus' });
  assert.equal(r.status, 503);
  await ctx.boot();
  r = await ctx.api('POST', '/api/runs', { lesson: 'prometheus' });
  assert.equal(r.status, 202);
  assert.match(r.body.id, /^[a-z0-9]{8}$/);
  const idA = r.body.id;
  r = await ctx.api('POST', '/api/runs', { lesson: 'autoscale' });
  assert.equal(r.status, 202);
  assert.notEqual(r.body.id, idA);
  const ready = await readyIds(ctx.api, 2);
  assert.ok(ready.includes(idA));
  r = await ctx.api('POST', '/api/runs', { lesson: 'prometheus' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Run limit reached/);
  r = await ctx.api('POST', '/api/runs', { lesson: 'nope' });
  assert.equal(r.status, 400);
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
