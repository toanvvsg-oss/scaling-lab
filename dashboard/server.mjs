import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { clusterState, runScenario } from './runner.mjs';
import { LoadSession, PROFILES } from './load.mjs';
import { createHistory, pushPoint, pushMilestone } from './timeline.mjs';
import { validateResetTarget, runReset } from './reset.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const files = { '/': ['index.html', 'text/html'], '/worksheet': ['worksheet.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/diagram.css': ['diagram.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'], '/diagram.js': ['diagram.js', 'text/javascript'], '/timeline-ui.js': ['timeline-ui.js', 'text/javascript'], '/worksheet.js': ['worksheet.js', 'text/javascript'] };
const state = { running: false, scenario: null, events: [], result: null, error: null, started: null, resetting: false, resetSteps: [], load: null, timeline: createHistory(), prediction: null };
function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
function emit(type, data) {
  const event = { at: new Date().toISOString(), type, data };
  state.events.push(event);
  if (state.events.length > 2500) state.events.shift();
  if (type === 'hpa' || type === 'cluster' || type === 'endpoint' || type === 'load' || type === 'request') {
    const d = data || {};
    if (type === 'request' && d.ok === false) pushMilestone(state.timeline, { at: event.at, kind: 'failure', text: `Request failure ${d.error || d.status || ''}`, detail: `Pod ${d.pod || 'unknown'} returned an error. Failures do not drive scaling directly; they signal overload or draining pods.`, observer: 'dashboard load client' });
    else if (type === 'load') pushMilestone(state.timeline, { at: event.at, kind: 'load', text: d.text || 'Load change', detail: `Offered traffic target is now ${d.rps ?? '?'} req/s. Prometheus observes this after its 5s scrape; HPA reacts later.`, observer: 'load controller' });
    else if (type === 'hpa') pushMilestone(state.timeline, { at: event.at, kind: 'hpa', text: d.text || 'HPA decision', detail: 'HPA desired replicas changed. Pod creation and readiness lag behind this decision.', observer: 'Kubernetes HPA' });
    else pushMilestone(state.timeline, { at: event.at, kind: type, text: d.text || type, detail: type === 'cluster' ? 'Pod created, became ready/terminating, or was removed. New pods must pass readiness before receiving traffic.' : 'Endpoint readiness changed; the Service only sends traffic to ready, non-terminating endpoints.', observer: type === 'cluster' ? 'kubelet / Deployment' : 'EndpointSlice controller' });
  }
  return event;
}

const load = new LoadSession(emit);
function loadState() { return load.state(); }

// --- Prometheus sampler for the unified timeline ---
let promForward = null;
let promPort = null;
async function ensurePromForward() {
  if (promForward && promPort) return promPort;
  const child = spawn('kubectl', ['--context', 'kind-scaling-lab', '-n', 'scaling-lab', 'port-forward', '--address', '127.0.0.1', 'service/prometheus', ':9090'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Prometheus port-forward did not start')); }, 12000);
    let output = '';
    const inspect = (chunk) => {
      output += chunk.toString();
      const m = output.match(/Forwarding from 127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timeout); resolve(Number(m[1])); }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.on('error', (e) => { clearTimeout(timeout); reject(e); });
    child.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`Prometheus port-forward exited ${code}`)); });
  }).catch((e) => { try { child.kill(); } catch { /* ignore */ } promForward = null; promPort = null; throw e; });
  promForward = child;
  promPort = port;
  child.on('exit', () => { promForward = null; promPort = null; });
  return port;
}
const REQUEST_RATE_QUERY = 'sum(rate(scaling_lab_http_requests_total{job="scaling-app"}[30s]))';
async function queryPromRate() {
  try {
    const port = await ensurePromForward();
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/query?query=${encodeURIComponent(REQUEST_RATE_QUERY)}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { value: null, stale: true };
    const data = await response.json();
    if (data.status !== 'success') return { value: null, stale: true };
    const v = data.data?.result?.[0]?.value?.[1];
    return v == null ? { value: null, stale: true } : { value: Number(v), stale: false };
  } catch { return { value: null, stale: true }; }
}

let sampling = false;
async function sampleTimeline() {
  if (sampling) return;
  sampling = true;
  try {
    const [cluster, rate] = await Promise.all([clusterState(), queryPromRate()]);
    if (!cluster.connected) return;
    const actual = cluster.pods.filter((p) => !p.terminating).length;
    const ready = cluster.pods.filter((p) => p.ready && !p.terminating).length;
    pushPoint(state.timeline, {
      offeredRps: load.active ? load.targetRps : 0,
      observedRps: rate.value,
      stale: rate.stale,
      desired: cluster.hpa?.desired ?? null,
      actual, ready,
    });
  } finally { sampling = false; }
}
setInterval(sampleTimeline, 5000);

function observeCluster() {
  let previous = null, busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const now = await clusterState();
      if (!now.connected) return;
      if (previous) {
        const oldPods = new Map(previous.pods.map(x => [x.name, x]));
        for (const pod of now.pods) {
          const old = oldPods.get(pod.name);
          if (!old) emit('cluster', { text: `${pod.name} created` });
          else if (old.terminating !== pod.terminating || old.ready !== pod.ready) emit('cluster', { text: `${pod.name}: ${pod.terminating ? 'terminating' : pod.ready ? 'ready' : 'not ready'}` });
          oldPods.delete(pod.name);
        }
        for (const name of oldPods.keys()) emit('cluster', { text: `${name} removed` });
        const oldEndpoints = new Map(previous.endpoints.map(x => [x.pod, x]));
        for (const endpoint of now.endpoints) {
          const old = oldEndpoints.get(endpoint.pod);
          if (!old || old.ready !== endpoint.ready || old.terminating !== endpoint.terminating) emit('endpoint', { text: `${endpoint.pod}: ${endpoint.terminating ? 'terminating' : endpoint.ready ? 'ready' : 'not ready'}` });
        }
        if (now.hpa?.desired !== previous.hpa?.desired) emit('hpa', { text: `Desired replicas: ${now.hpa?.desired ?? 'none'}` });
      }
      previous = now;
    } finally { busy = false; }
  }, 750);
  return () => clearInterval(timer);
}

async function readBody(req, limit = 4096) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('Request too large');
  }
  return body ? JSON.parse(body) : {};
}

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET' && path === '/api/state') {
    return send(res, 200, { ...state, load: loadState(), profiles: Object.fromEntries(Object.entries(PROFILES).map(([k, v]) => [k, { initialRps: v.initialRps, minRps: v.minRps, maxRps: v.maxRps, step: v.step }])) });
  }
  if (req.method === 'GET' && path === '/api/cluster') return send(res, 200, await clusterState());
  if (req.method === 'GET' && path === '/api/load') return send(res, 200, loadState());
  if (req.method === 'GET' && path === '/api/timeline') return send(res, 200, state.timeline);
  if (req.method === 'GET' && path === '/api/evidence') {
    return send(res, 200, { scenario: state.scenario, started: state.started, result: state.result, error: state.error, load: loadState(), timeline: state.timeline, events: state.events });
  }
  if (req.method === 'POST' && path === '/api/predict') {
    try {
      const input = await readBody(req);
      if (!['up', 'down', 'same'].includes(input.guess)) return send(res, 400, { error: 'Guess must be up, down, or same.' });
      state.prediction = { guess: input.guess, at: new Date().toISOString(), revealed: false };
      return send(res, 200, { recorded: true });
    } catch { return send(res, 400, { error: 'Invalid JSON' }); }
  }
  if (req.method === 'POST' && path === '/api/reveal') {
    if (!state.prediction) return send(res, 400, { error: 'Record a prediction first.' });
    state.prediction.revealed = true;
    return send(res, 200, { explanation: 'Prometheus scrapes every 5s, KEDA polls every 5s, and HPA stabilizes scale-down for 60s. Expect: offered RPS rises first, scraped RPS follows, desired replicas follow, Ready pods arrive last; reverse on scale-in.' });
  }
  if (req.method === 'POST' && path === '/api/load') {
    try {
      const input = await readBody(req);
      const action = input.action;
      if (!['start', 'increase', 'decrease', 'stop'].includes(action)) return send(res, 400, { error: 'Unknown load action. Expected start, increase, decrease, or stop.' });
      if (state.running) return send(res, 409, { error: 'A one-click scenario is running. Wait for it before manual load.' });
      if (state.resetting) return send(res, 409, { error: 'A reset is in progress. Wait for it before manual load.' });
      if (action === 'start') {
        if (load.active) return send(res, 409, { error: 'A load session is already running. Stop it before starting another.' });
        if (!input.profile || !Object.hasOwn(PROFILES, input.profile)) return send(res, 400, { error: 'Unknown profile. Expected steady, ramp, or burst.' });
        await load.start(input.profile);
        await sampleTimeline();
        return send(res, 200, loadState());
      }
      if (!load.active) return send(res, 400, { error: 'No active load session.' });
      if (action === 'increase') return send(res, 200, load.increase());
      if (action === 'decrease') return send(res, 200, load.decrease());
      return send(res, 200, await load.stop('stopped from UI'));
    } catch (error) {
      const status = /already running/.test(error.message) ? 409 : 400;
      return send(res, status, { error: error.message });
    }
  }
  if (req.method === 'POST' && path === '/api/reset') {
    if (state.running) return send(res, 409, { error: 'A scenario is running. Wait for it before reset.' });
    if (state.resetting) return send(res, 409, { error: 'A reset is already in progress.' });
    let input;
    try { input = await readBody(req); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
    try { validateResetTarget(input.target); } catch (error) { return send(res, 400, { error: error.message }); }
    state.resetting = true;
    state.resetSteps = [];
    state.error = null;
    send(res, 202, { started: true, target: input.target });
    try {
      if (load.active) await load.stop('stopped by reset');
      const result = await runReset(input.target, (type, data) => {
        state.resetSteps.push({ at: new Date().toISOString(), ...data });
        emit(type, data);
      });
      state.resetting = false;
      emit('note', { text: `Reset to ${input.target} complete: ${result.readyPods} Ready pods.` });
      await sampleTimeline();
    } catch (error) {
      state.resetting = false;
      state.error = error.message;
      emit('error', { text: `Reset failed: ${error.message}` });
    }
    return;
  }
  if (req.method === 'POST' && path === '/api/run') {
    if (state.running) return send(res, 409, { error: 'A scenario is already running' });
    if (state.resetting) return send(res, 409, { error: 'A reset is in progress. Wait for it.' });
    if (load.active) return send(res, 409, { error: 'Manual load is running. Stop it before the one-click scenario.' });
    let input;
    try { input = await readBody(req); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
    if (!['connections', 'timeouts', 'shutdown', 'rollout', 'streaming', 'autoscale', 'prometheus'].includes(input.id)) return send(res, 400, { error: 'Unknown scenario' });
    Object.assign(state, { running: true, scenario: input.id, events: [], result: null, error: null, started: new Date().toISOString(), timeline: createHistory(), prediction: null });
    send(res, 202, { started: true });
    const stopObservation = observeCluster();
    runScenario(input.id, { mode: input.mode }, emit)
      .then(result => { state.result = result; emit('result', { status: result.status }); })
      .catch(error => { state.error = error.message; emit('error', { text: error.message }); })
      .finally(() => { state.running = false; stopObservation(); sampleTimeline(); });
    return;
  }
  if (req.method === 'GET' && files[path]) {
    const [name, contentType] = files[path];
    try {
      const content = await readFile(join(root, name));
      res.writeHead(200, { 'content-type': `${contentType}; charset=utf-8`, 'cache-control': 'no-store' });
      res.end(content);
    } catch { send(res, 500, { error: 'Asset unavailable' }); }
    return;
  }
  // Backwards compatibility: old prometheus-ui.js path now serves the timeline UI.
  if (req.method === 'GET' && path === '/prometheus-ui.js') {
    try {
      const content = await readFile(join(root, 'timeline-ui.js'));
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(content);
    } catch { send(res, 500, { error: 'Asset unavailable' }); }
    return;
  }
  send(res, 404, { error: 'Not found' });
});
server.listen(4173, '127.0.0.1', () => console.log('Dashboard: http://127.0.0.1:4173'));
