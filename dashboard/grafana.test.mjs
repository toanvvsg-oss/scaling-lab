import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  dashboardUrl, panelEmbedUrl, grafanaPort, closeGrafanaForward,
  GRAFANA_DASHBOARD_UID,
} from './grafana.mjs';

test('dashboard URL carries the selected run as a dashboard variable', () => {
  const url = dashboardUrl('http://127.0.0.1:13000', 'aaaabbbb');
  assert.ok(url.startsWith('http://127.0.0.1:13000/d/scaling-lab/'), url);
  assert.match(url, /var-run=aaaabbbb/);
  assert.equal(dashboardUrl('http://127.0.0.1:13000/', 'aaaabbbb'), url);
});

test('dashboard URL without a run omits the variable', () => {
  const url = dashboardUrl('http://127.0.0.1:13000');
  assert.doesNotMatch(url, /var-run/);
});

test('panel embed URL pins the run and the status panel', () => {
  const url = panelEmbedUrl('http://127.0.0.1:13000', 'aaaabbbb');
  assert.match(url, /d-solo\/scaling-lab\//);
  assert.match(url, /var-run=aaaabbbb/);
  assert.match(url, /panelId=7/);
  assert.match(url, /kiosk/);
});

test('run ids and panel ids are validated, never interpolated raw', () => {
  assert.throws(() => dashboardUrl('http://127.0.0.1:13000', 'SCALING-LAB'), /Invalid run id/);
  assert.throws(() => panelEmbedUrl('http://127.0.0.1:13000', 'evil'), /Invalid run id/);
  assert.throws(() => panelEmbedUrl('http://127.0.0.1:13000', 'aaaabbbb', -1), /Invalid panel id/);
  assert.equal(GRAFANA_DASHBOARD_UID, 'scaling-lab');
});

// Fake kubectl spawner: no processes, no cluster. Children resolve their
// port on the next microtask to mimic async port-forward startup.
function fakeSpawn({ port = 13001, behavior = 'ready' } = {}) {
  const calls = [];
  const children = [];
  const spawnImpl = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (behavior === 'throw') throw new Error('no kubectl here');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; child.emit('exit', 143); };
    children.push(child);
    queueMicrotask(() => {
      if (behavior === 'exit') child.emit('exit', 1);
      else if (behavior === 'error') child.emit('error', new Error('boom'));
      else child.stderr.emit('data', `Forwarding from 127.0.0.1:${port} -> 3000\n`);
    });
    return child;
  };
  return { calls, children, spawnImpl };
}

test('concurrent startups share one pending child', async (t) => {
  t.after(() => closeGrafanaForward());
  const f = fakeSpawn({ port: 13111 });
  const [a, b] = await Promise.all([grafanaPort(f.spawnImpl), grafanaPort(f.spawnImpl)]);
  assert.equal(a, 13111);
  assert.equal(b, 13111);
  assert.equal(f.children.length, 1, 'single-flight: one child for concurrent callers');
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0], /service\/grafana/);
});

test('close kills only the tracked forward and the next call respawns', async (t) => {
  t.after(() => closeGrafanaForward());
  const a = fakeSpawn({ port: 13121 });
  assert.equal(await grafanaPort(a.spawnImpl), 13121);
  closeGrafanaForward();
  assert.equal(a.children[0].killed, true);
  const b = fakeSpawn({ port: 13122 });
  assert.equal(await grafanaPort(b.spawnImpl), 13122);
  assert.equal(b.children.length, 1);
  assert.equal(a.children[0].killed, true, 'first child stays dead, never revived');
});

test('a stale child exit never clears a newer forward', async (t) => {
  t.after(() => closeGrafanaForward());
  const a = fakeSpawn({ port: 13211 });
  assert.equal(await grafanaPort(a.spawnImpl), 13211);
  closeGrafanaForward();
  const b = fakeSpawn({ port: 13212 });
  const pending = grafanaPort(b.spawnImpl);
  // The old child reports its exit late, after replacement started.
  a.children[0].emit('exit', 143);
  assert.equal(await pending, 13212);
  // And the established route still resolves to the newer port.
  const c = fakeSpawn({ port: 13999 });
  assert.equal(await grafanaPort(c.spawnImpl), 13212, 'no extra spawn while a forward is established');
  assert.equal(c.children.length, 0);
});

test('spawn failure rejects, clears state, and the next call retries', async (t) => {
  t.after(() => closeGrafanaForward());
  await assert.rejects(grafanaPort(fakeSpawn({ behavior: 'throw' }).spawnImpl), /no kubectl/);
  await assert.rejects(grafanaPort(fakeSpawn({ behavior: 'exit' }).spawnImpl), /exited 1/);
  await assert.rejects(grafanaPort(fakeSpawn({ behavior: 'error' }).spawnImpl), /boom/);
  const good = fakeSpawn({ port: 13131 });
  assert.equal(await grafanaPort(good.spawnImpl), 13131);
});

async function bootGrafanaApp(t, grafanaApi) {
  const { createApp, prodDeps } = await import('./server.mjs');
  const R = await import('./runs.mjs');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  R.runs.clear(); R.archives.clear();
  const dir = mkdtempSync(join(tmpdir(), 'lab-graf-'));
  const idle = () => ({
    active: false,
    state() { return { active: false }; },
    async start() { this.active = true; return this.state(); },
    async stop() { this.active = false; return this.state(); },
    increase() { return this.state(); },
    decrease() { return this.state(); },
  });
  const app = createApp({
    clusterState: async () => ({ connected: false, pods: [], endpoints: [] }),
    runScenario: async () => ({ status: 'pass', checks: [], evidence: {} }),
    loadFactory: () => idle(),
    runsApi: { ...prodDeps.runsApi, adoptOrphanRuns: async () => [] },
    promQuery: async () => ({ value: null, at: null, stale: true }),
    queryRunSamples: async () => ({ total: null, at: null, upAllOne: false, evaluatedAt: null, stale: true }),
    resetApi: { validateResetTarget: (x) => x, runReset: async () => ({}) },
    runAction: async () => ({}),
    grafanaApi,
    resultsDir: dir,
    enableSampler: false,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  t.after(() => { R.runs.clear(); R.archives.clear(); });
  await app.boot();
  return { app, port: app.server.address().port, R };
}

test('unavailable monitoring reports nulls without starting any route', async (t) => {
  let statusCalls = 0;
  const { port } = await bootGrafanaApp(t, {
    status: async () => { statusCalls++; return { available: false, baseUrl: null }; },
    close: () => {},
  });
  const res = await fetch(`http://127.0.0.1:${port}/api/grafana`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { available: false, baseUrl: null, dashboardUrl: null });
  assert.equal(statusCalls, 1);
});

test('unknown runs are rejected before any route starts', async (t) => {
  let statusCalls = 0;
  const { port } = await bootGrafanaApp(t, {
    status: async () => { statusCalls++; return { available: true, baseUrl: 'http://127.0.0.1:13999' }; },
    close: () => {},
  });
  const res = await fetch(`http://127.0.0.1:${port}/api/grafana?run=deadbeef`);
  assert.equal(res.status, 404);
  assert.equal(statusCalls, 0, 'no forward started for an unknown run');
});

test('known runs get dashboard and embed URLs from the stubbed route', async (t) => {
  let closed = 0;
  const ctx = await bootGrafanaApp(t, {
    status: async () => ({ available: true, baseUrl: 'http://127.0.0.1:13998' }),
    close: () => { closed++; },
  });
  ctx.R.runs.set('aaaabbbb', { id: 'aaaabbbb' });
  const res = await fetch(`http://127.0.0.1:${ctx.port}/api/grafana?run=aaaabbbb`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, true);
  assert.match(body.runUrl, /var-run=aaaabbbb/);
  assert.match(body.embedUrl, /d-solo\/scaling-lab.*var-run=aaaabbbb.*panelId=7/);
  await ctx.app.close();
  assert.equal(closed, 1, 'app close releases the process-owned forward');
});
