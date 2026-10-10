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
