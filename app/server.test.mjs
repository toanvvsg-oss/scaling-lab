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

test('probes stay out of learner counters while completed responses and latency histogram record bounded labels', async (t) => {
  const child = await boot(13992);
  t.after(() => child.kill());
  await fetch('http://127.0.0.1:13992/health/live');
  await fetch('http://127.0.0.1:13992/health/ready');
  await fetch('http://127.0.0.1:13992/fast');
  await fetch('http://127.0.0.1:13992/demo/500');
  const metrics = await (await fetch('http://127.0.0.1:13992/metrics')).text();
  const total = metrics.match(/scaling_lab_http_requests_total\{pod="[^"]*"\} (\d+)/);
  assert.equal(Number(total[1]), 2, 'only learner routes count');
  assert.match(metrics, /scaling_lab_http_responses_total\{pod="[^"]*",method="GET",route="fast",status="200",status_class="2xx"\} 1/);
  assert.match(metrics, /scaling_lab_http_responses_total\{pod="[^"]*",method="GET",route="demo-500",status="500",status_class="5xx"\} 1/);
  assert.ok(!metrics.includes('route="/fast"'), 'no raw paths as label values');
  assert.match(metrics, /scaling_lab_http_response_duration_seconds_count\{pod="[^"]*",route="fast"\} 1/);
  assert.match(metrics, /scaling_lab_http_response_duration_seconds_bucket\{pod="[^"]*",route="fast",le="\+Inf"\} 1/);
  assert.match(metrics, /scaling_lab_http_inflight_requests\{pod="[^"]*"\} 0/);
});
