import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { clusterState, runScenario } from './runner.mjs';
import { LoadSession, PROFILES } from './load.mjs';
import { createHistory, pushPoint, pushMilestone } from './timeline.mjs';
import { validateResetTarget, runReset } from './reset.mjs';
import { queryPrometheus, LEGACY_RATE_QUERY, rateQueryForRun } from './prometheus.mjs';
import { runs, archives, activeRuns, MAX_ACTIVE_RUNS, RUN_LESSONS, validateRunId, describeRun, createRun, cleanupRun, runClusterState, buildArchive } from './runs.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(root, '..', 'results');
const files = { '/': ['index.html', 'text/html'], '/worksheet': ['worksheet.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/diagram.css': ['diagram.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'], '/diagram.js': ['diagram.js', 'text/javascript'], '/timeline-ui.js': ['timeline-ui.js', 'text/javascript'], '/worksheet.js': ['worksheet.js', 'text/javascript'] };
const state = { running: false, scenario: null, events: [], result: null, error: null, started: null, resetting: false, resetSteps: [], load: null, timeline: createHistory(), prediction: null };
function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
// store is { events, timeline }: the global dashboard state or one run record.
// Run milestones stay in the run's own timeline; the legacy timeline is untouched.
function pushEvent(store, type, data) {
  const event = { at: new Date().toISOString(), type, data };
  store.events.push(event);
  if (store.events.length > 2500) store.events.shift();
  // Only failures become milestones. Successful sampled requests stay in the
  // event log; milestone history is reserved for load changes, HPA decisions,
  // pod/endpoint changes, and request failures.
  if (type === 'request') {
    if (data?.ok === false) pushMilestone(store.timeline, { at: event.at, kind: 'failure', text: `Request failure ${data.error || data.status || ''}`, detail: `Pod ${data.pod || 'unknown'} returned an error. Failures do not drive scaling directly; they signal overload or draining pods.`, observer: 'dashboard load client' });
    return event;
  }
  if (type === 'hpa' || type === 'cluster' || type === 'endpoint' || type === 'load') {
    const d = data || {};
    if (type === 'load') pushMilestone(store.timeline, { at: event.at, kind: 'load', text: d.text || 'Load change', detail: `Offered traffic target is now ${d.rps ?? '?'} req/s. Prometheus observes this after its 5s scrape; HPA reacts later.`, observer: 'load controller' });
    else if (type === 'hpa') pushMilestone(store.timeline, { at: event.at, kind: 'hpa', text: d.text || 'HPA decision', detail: 'HPA desired replicas changed. Pod creation and readiness lag behind this decision.', observer: 'Kubernetes HPA' });
    else pushMilestone(store.timeline, { at: event.at, kind: type, text: d.text || type, detail: type === 'cluster' ? 'Pod created, became ready/terminating, or was removed. New pods must pass readiness before receiving traffic.' : 'Endpoint readiness changed; the Service only sends traffic to ready, non-terminating endpoints.', observer: type === 'cluster' ? 'kubelet / Deployment' : 'EndpointSlice controller' });
  }
  return event;
}
function emit(type, data) {
  return pushEvent(state, type, data);
}
function runEmit(run, type, data) {
  return pushEvent(run, type, { ...data, run: run.id });
}

const load = new LoadSession(emit);
function loadState() { return load.state(); }

const profilesPayload = () => Object.fromEntries(Object.entries(PROFILES).map(([k, v]) => [k, { initialRps: v.initialRps, minRps: v.minRps, maxRps: v.maxRps, step: v.step }]));

let sampling = false;
async function sampleTimeline() {
  if (sampling) return;
  sampling = true;
  try {
    const [cluster, rate] = await Promise.all([clusterState(), queryPrometheus(LEGACY_RATE_QUERY)]);
    if (!cluster.connected) return;
    const actual = cluster.pods.filter((p) => !p.terminating).length;
    const ready = cluster.pods.filter((p) => p.ready && !p.terminating).length;
    pushPoint(state.timeline, {
      offeredRps: load.active ? load.offeredLastSecond : 0,
      offeredTarget: load.active ? load.targetRps : 0,
      observedRps: rate.value,
      observedAt: rate.at,
      stale: rate.stale,
      desired: cluster.hpa?.desired ?? null,
      actual, ready,
    });
  } finally { sampling = false; }
}

function diffRunState(run, now) {
  const prev = run.prev;
  if (prev) {
    const oldPods = new Map(prev.pods.map((x) => [x.name, x]));
    for (const pod of now.pods) {
      const old = oldPods.get(pod.name);
      if (!old) runEmit(run, 'cluster', { text: `${pod.name} created` });
      else if (old.terminating !== pod.terminating || old.ready !== pod.ready) runEmit(run, 'cluster', { text: `${pod.name}: ${pod.terminating ? 'terminating' : pod.ready ? 'ready' : 'not ready'}` });
      oldPods.delete(pod.name);
    }
    for (const name of oldPods.keys()) runEmit(run, 'cluster', { text: `${name} removed` });
    const oldEndpoints = new Map(prev.endpoints.map((x) => [x.pod, x]));
    for (const endpoint of now.endpoints) {
      const old = oldEndpoints.get(endpoint.pod);
      if (!old || old.ready !== endpoint.ready || old.terminating !== endpoint.terminating) runEmit(run, 'endpoint', { text: `${endpoint.pod}: ${endpoint.terminating ? 'terminating' : endpoint.ready ? 'ready' : 'not ready'}` });
    }
    if (now.hpa?.desired !== prev.hpa?.desired) runEmit(run, 'hpa', { text: `Desired replicas: ${now.hpa?.desired ?? 'none'}` });
  }
  run.prev = now;
}

async function sampleRuns() {
  for (const run of runs.values()) {
    if (run.status !== 'ready') continue;
    try {
      const [snap, rate] = await Promise.all([runClusterState(run.id), queryPrometheus(rateQueryForRun(run.id))]);
      if (!snap.connected) continue;
      diffRunState(run, snap);
      pushPoint(run.timeline, {
        offeredRps: run.load?.active ? run.load.offeredLastSecond : 0,
        offeredTarget: run.load?.active ? run.load.targetRps : 0,
        observedRps: rate.value,
        observedAt: rate.at,
        stale: rate.stale,
        desired: snap.hpa?.desired ?? null,
        actual: snap.pods.filter((p) => !p.terminating).length,
        ready: snap.pods.filter((p) => p.ready && !p.terminating).length,
      });
    } catch { /* skip this round for this run */ }
  }
}

setInterval(async () => { await sampleTimeline(); await sampleRuns(); }, 5000);

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

function getRun(id) {
  validateRunId(id);
  const run = runs.get(id);
  if (!run) return null;
  return run;
}

async function runLoadAction(run, action, profile) {
  const session = run.load;
  if (!session) throw new Error(`Run ${run.id} is not ready for traffic yet.`);
  if (action === 'start') {
    if (session.active) throw Object.assign(new Error('A load session is already running for this run. Stop it before starting another.'), { status: 409 });
    if (!profile || !Object.hasOwn(PROFILES, profile)) throw new Error('Unknown profile. Expected steady, ramp, or burst.');
    await session.start(profile);
    await sampleRuns();
    return session.state();
  }
  if (!session.active) throw new Error('No active load session for this run.');
  if (action === 'increase') return session.increase();
  if (action === 'decrease') return session.decrease();
  return session.stop('stopped from UI');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  if (req.method === 'GET' && path === '/api/state') {
    return send(res, 200, { ...state, load: loadState(), profiles: profilesPayload(), runs: [...runs.values()].map(describeRun), archivedRuns: [...archives.keys()], maxActiveRuns: MAX_ACTIVE_RUNS });
  }
  if (req.method === 'GET' && path === '/api/cluster') return send(res, 200, await clusterState());
  if (req.method === 'GET' && path === '/api/load') return send(res, 200, loadState());
  if (req.method === 'GET' && path === '/api/timeline') return send(res, 200, state.timeline);
  if (req.method === 'GET' && path === '/api/evidence') {
    const runParam = url.searchParams.get('run');
    if (runParam) {
      try { validateRunId(runParam); } catch (error) { return send(res, 400, { error: error.message }); }
      const live = runs.get(runParam);
      if (live) return send(res, 200, buildArchive(live));
      const archived = archives.get(runParam);
      if (archived) return send(res, 200, archived);
      // Archive files survive dashboard restarts; serve them as a fallback.
      try {
        const file = await readFile(join(resultsDir, `archive-${runParam}.json`), 'utf8');
        return send(res, 200, JSON.parse(file));
      } catch {
        return send(res, 404, { error: `Unknown run: ${runParam}` });
      }
    }
    return send(res, 200, { scenario: state.scenario, started: state.started, result: state.result, error: state.error, load: loadState(), timeline: state.timeline, events: state.events });
  }
  if (req.method === 'GET' && path === '/api/runs') {
    return send(res, 200, [...runs.values()].map(describeRun));
  }
  if (req.method === 'POST' && path === '/api/runs') {
    let input;
    try { input = await readBody(req); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
    if (!RUN_LESSONS.has(input.lesson)) return send(res, 400, { error: 'Unknown run lesson. Expected prometheus.' });
    if (activeRuns().length >= MAX_ACTIVE_RUNS) return send(res, 409, { error: `Run limit reached (${MAX_ACTIVE_RUNS} active runs: ${activeRuns().map((r) => r.id).join(', ')}). Clean up a run before creating another.` });
    send(res, 202, { started: true });
    createRun(input.lesson, emit)
      .then((run) => {
        run.load = new LoadSession((t, d) => runEmit(run, t, d));
        run.load.endpoint = `http://127.0.0.1:${run.forwardPort}`;
        emit('note', { text: `Run ${run.id} ready in ${run.ns}.` });
      })
      .catch((error) => emit('error', { text: `Run creation failed: ${error.message}` }));
    return;
  }
  const runMatch = path.match(/^\/api\/runs\/([A-Za-z0-9-]+)(\/(timeline|load))?$/);
  if (runMatch) {
    let run;
    try { run = getRun(runMatch[1]); } catch (error) { return send(res, 400, { error: error.message }); }
    if (!run) return send(res, 404, { error: `Unknown run: ${runMatch[1]}` });
    const sub = runMatch[3];
    if (req.method === 'GET' && !sub) return send(res, 200, { ...describeRun(run), events: run.events.slice(-200) });
    if (req.method === 'GET' && sub === 'timeline') return send(res, 200, run.timeline);
    if (req.method === 'POST' && sub === 'load') {
      try {
        const input = await readBody(req);
        if (!['start', 'increase', 'decrease', 'stop'].includes(input.action)) return send(res, 400, { error: 'Unknown load action. Expected start, increase, decrease, or stop.' });
        if (run.status !== 'ready') return send(res, 409, { error: `Run ${run.id} is ${run.status}. Wait before sending traffic.` });
        return send(res, 200, await runLoadAction(run, input.action, input.profile));
      } catch (error) {
        return send(res, error.status || 400, { error: error.message });
      }
    }
    if (req.method === 'DELETE' && !sub) {
      if (run.status === 'deleting' || run.status === 'deleted') return send(res, 409, { error: `Run ${run.id} is already ${run.status}.` });
      send(res, 202, { started: true, run: run.id, namespace: run.ns });
      cleanupRun(run.id, resultsDir)
        .then(() => emit('note', { text: `Run ${run.id} cleaned up (${run.ns} deleted). Evidence remains downloadable.` }))
        .catch((error) => emit('error', { text: `Run cleanup failed: ${error.message}` }));
      return;
    }
    return send(res, 405, { error: 'Method not allowed for this run resource.' });
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
      state.timeline = createHistory();
      pushMilestone(state.timeline, { kind: 'reset', text: `Reset to ${input.target} complete: ${result.readyPods} Ready pods.`, detail: 'Timeline restarts here; earlier points belonged to the previous scaler and are kept in downloaded evidence.', observer: 'reset controller' });
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
