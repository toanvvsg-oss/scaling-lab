import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

function boot(port) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['app/server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stderr.on('data', (c) => { out += c.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('app did not boot: ' + out)); }, 10000);
    const poll = setInterval(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health/live`);
        if (r.ok) { clearInterval(poll); clearTimeout(timer); resolve(child); }
      } catch { /* not up yet */ }
    }, 200);
  });
}

test('lifecycle hook logs preStop markers without touching request counters', async (t) => {
  const child = await boot(13991);
  t.after(() => child.kill());
  const r = await fetch('http://127.0.0.1:13991/lifecycle', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phase: 'preStop' }),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  await fetch('http://127.0.0.1:13991/fast');
  const metrics = await (await fetch('http://127.0.0.1:13991/metrics')).text();
  const m = metrics.match(/scaling_lab_http_requests_total\{pod="[^"]*"\} (\d+)/);
  assert.ok(m, 'counter present');
  assert.equal(Number(m[1]), 1, 'lifecycle call excluded from learner request counter');
});

test('alloc caps per-request memory server-side', async (t) => {
  const child = await boot(13992);
  t.after(() => child.kill());
  const r = await fetch('http://127.0.0.1:13992/alloc?mb=64&holdMs=10');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).allocatedMb, 32, 'per-request cap enforced');
});

test('dep without upstream is an explicit 501, shed load is a counted 502', async (t) => {
  const child = await boot(13993);
  t.after(() => child.kill());
  const r = await fetch('http://127.0.0.1:13993/dep?ms=50');
  assert.equal(r.status, 501);
  const metrics = await (await fetch('http://127.0.0.1:13993/metrics')).text();
  assert.match(metrics, /route="dep"/, 'dep route recorded in metrics');
});

test('dep forwards to upstream and sheds past the pool cap', async (t) => {
  const { spawn } = await import('node:child_process');
  const dep = spawn('node', ['app/server.mjs'], { env: { ...process.env, PORT: '13994' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => dep.kill());
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch('http://127.0.0.1:13994/health/live'); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const app = spawn('node', ['app/server.mjs'], {
    env: { ...process.env, PORT: '13995', UPSTREAM_URL: 'http://127.0.0.1:13994', DEP_POOL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => app.kill());
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch('http://127.0.0.1:13995/health/live'); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const fast = await fetch('http://127.0.0.1:13995/dep?ms=50&via=slow');
  assert.equal(fast.status, 200);
  assert.ok((await fast.json()).depPod, 'upstream pod identity returned');
  // Occupy the single pool slot with a slow upstream call, then shed.
  const slow = fetch('http://127.0.0.1:13995/dep?ms=1500&via=slow');
  await new Promise((r) => setTimeout(r, 300));
  const shed = await fetch('http://127.0.0.1:13995/dep?ms=50&via=slow');
  assert.equal(shed.status, 502);
  assert.equal((await shed.json()).shed, true);
  assert.equal((await slow).status, 200);
  const metrics = await (await fetch('http://127.0.0.1:13995/metrics')).text();
  assert.match(metrics, /scaling_lab_dep_shed_total\{pod="[^"]*"\} 1/, 'shed load counted apart from latency');
});

test('alloc rejects non-finite input without crashing', async (t) => {
  const child = await boot(13996);
  t.after(() => child.kill());
  for (const q of ['mb=abc', 'mb=8&holdMs=xyz', 'mb=Infinity']) {
    const r = await fetch(`http://127.0.0.1:13996/alloc?${q}`);
    assert.equal(r.status, 400, q);
  }
  const ok = await fetch('http://127.0.0.1:13996/fast');
  assert.equal(ok.status, 200, 'service still serving after bad input');
});

test('dep requires a complete upstream body, counts real attempts', async (t) => {
  const { spawn } = await import('node:child_process');
  const { default: http } = await import('node:http');
  // Upstream that sends 200 headers then resets mid-body.
  const evil = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-pod': 'evil-dep' });
    res.write('{"partial":');
    setTimeout(() => res.destroy(), 50);
  });
  await new Promise((r) => evil.listen(13997, '127.0.0.1', r));
  t.after(() => new Promise((r) => evil.close(r)));
  const app = spawn('node', ['app/server.mjs'], {
    env: { ...process.env, PORT: '13998', UPSTREAM_URL: 'http://127.0.0.1:13997' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => app.kill());
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch('http://127.0.0.1:13998/health/live'); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const r = await fetch('http://127.0.0.1:13998/dep?ms=50&via=slow');
  const body = await r.json();
  assert.ok(r.status === 502 || r.status === 504, `interrupted upstream is a failure, got ${r.status}`);
  assert.equal(body.attempts, 1, 'attempts counted, default no retries');
  assert.notEqual(body.depPod, 'evil-dep', 'reset body never surfaces as success');
});
