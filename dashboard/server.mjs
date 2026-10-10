import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { clusterState, runScenario } from './runner.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const files = { '/': ['index.html', 'text/html'], '/worksheet': ['worksheet.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/diagram.css': ['diagram.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'], '/diagram.js': ['diagram.js', 'text/javascript'], '/prometheus-ui.js': ['prometheus-ui.js', 'text/javascript'], '/worksheet.js': ['worksheet.js', 'text/javascript'] };
const state = { running: false, scenario: null, events: [], result: null, error: null, started: null };
function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
function emit(type, data) {
  state.events.push({ at: new Date().toISOString(), type, data });
  if (state.events.length > 2500) state.events.shift();
}
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
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET' && path === '/api/state') return send(res, 200, state);
  if (req.method === 'GET' && path === '/api/cluster') return send(res, 200, await clusterState());
  if (req.method === 'POST' && path === '/api/run') {
    if (state.running) return send(res, 409, { error: 'A scenario is already running' });
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 4096) return send(res, 413, { error: 'Request too large' });
    }
    let input;
    try { input = JSON.parse(body); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
    if (!['connections', 'timeouts', 'shutdown', 'rollout', 'streaming', 'autoscale', 'prometheus'].includes(input.id)) return send(res, 400, { error: 'Unknown scenario' });
    Object.assign(state, { running: true, scenario: input.id, events: [], result: null, error: null, started: new Date().toISOString() });
    send(res, 202, { started: true });
    const stopObservation = observeCluster();
    runScenario(input.id, { mode: input.mode }, emit)
      .then(result => { state.result = result; emit('result', { status: result.status }); })
      .catch(error => { state.error = error.message; emit('error', { text: error.message }); })
      .finally(() => { state.running = false; stopObservation(); });
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
  send(res, 404, { error: 'Not found' });
});
server.listen(4173, '127.0.0.1', () => console.log('Dashboard: http://127.0.0.1:4173'));
