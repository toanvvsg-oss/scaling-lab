import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { clusterState, runScenario } from './runner.mjs';
import { LoadSession, PROFILES, CPU_PROFILES, profileSet } from './load.mjs';
import { createHistory, pushPoint, pushMilestone } from './timeline.mjs';
import { validateResetTarget, runReset } from './reset.mjs';
import { queryPrometheus, queryRunSamples, LEGACY_RATE_QUERY, rateQueryForRun, upQueryForRun, counterSelForRun, upSelForRun } from './prometheus.mjs';
import { runs, archives, activeRuns, MAX_ACTIVE_RUNS, RUN_LESSONS, validateRunId, describeRun, beginRun, finishRun, createRun, cleanupRun, runClusterState, buildArchive, adoptOrphanRuns } from './runs.mjs';
import { runAction } from './actions.mjs';
import { grafanaStatus, closeGrafanaForward, dashboardUrl, panelEmbedUrl } from './grafana.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const resultsDir = process.env.SCALING_LAB_RESULTS_DIR ? resolve(process.env.SCALING_LAB_RESULTS_DIR) : join(root, '..', 'results');
// Worksheet keeps its classic page; the lab console itself is the built React app in dist/.
const files = { '/worksheet': ['worksheet.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/worksheet.js': ['worksheet.js', 'text/javascript'] };

export const EXPLANATIONS = {
  connections: 'One TCP connection can carry many requests (keep-alive), but the proxy terminates the client socket and picks its own upstream socket to Node.js. Reused client requests share an edge connection ID; fresh sockets get new ones — the two pools are independent.',
  timeouts: 'Each hop has its own idle timeout. The client-to-edge socket survives both gaps, the proxy-to-app socket survives the 1s gap, and Node.js closes its 5s keep-alive socket during the 6.5s gap — so only the long gap needs a new upstream connection.',
  shutdown: 'Pod termination runs the 2s preStop hook, then SIGTERM. In graceful mode Node.js stops accepting new work (server.close) while the 8s request finishes inside the 24s shutdown budget. In abrupt mode the process exits immediately and the in-flight request is interrupted.',
  rollout: 'maxSurge 1 starts a replacement pod before old ones stop; maxUnavailable 0 keeps required capacity. The new pod serves traffic only after its readiness probe passes, so sampled requests keep succeeding while pod IDs change.',
  streaming: 'The 20-tick stream stays active far longer than a fast response. Graceful shutdown lets the active response finish all 20 ticks before the pod exits; server.close waits for active HTTP requests instead of cutting them.',
  autoscale: 'HPA CPU utilization is measured against the 100m request with a 60% target. Metrics-server sampling, HPA reconciliation, and the 60s scale-down stabilization window delay every stage: load first, desired replicas later, Ready pods last.',
  prometheus: 'Prometheus scrapes every 5s, KEDA polls every 5s, and HPA stabilizes scale-down for 60s. Expect: offered RPS rises first, scraped RPS follows, desired replicas follow, Ready pods arrive last; reverse on scale-in.',
};

export const LOAD_DURATIONS = [60, 120, 180, 300];
const PREDICT_VALUES = new Set(['up', 'down', 'same', 'share', 'fresh']);

export const prodDeps = {
  clusterState, runScenario,
  loadFactory: (emitFn, opts) => new LoadSession(emitFn, opts),
  runsApi: {
    runs, archives, activeRuns, MAX_ACTIVE_RUNS, RUN_LESSONS,
    validateRunId, describeRun, beginRun, finishRun, createRun, cleanupRun, runClusterState, buildArchive, adoptOrphanRuns,
  },
  promQuery: queryPrometheus,
  queryRunSamples,
  counterSelForRun, upSelForRun,
  legacyRateQuery: LEGACY_RATE_QUERY,
  rateQueryForRun, upQueryForRun,
  resetApi: { validateResetTarget, runReset },
  runAction,
  // Managed local-only Grafana route lifecycle (fixed service, ephemeral
  // localhost port). Injected so tests can stub availability without
  // ever spawning kubectl against a live cluster.
  grafanaApi: { status: () => grafanaStatus(), close: () => closeGrafanaForward() },
  resultsDir,
  profiles: { request: PROFILES, cpu: CPU_PROFILES },
  enableSampler: true,
};

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

export function createApp(overrides = {}) {
  const io = { ...prodDeps, ...overrides };
  const R = io.runsApi;
  const state = { running: false, scenario: null, events: [], rev: 0, result: null, error: null, started: null, resetting: false, resetSteps: [], load: null, timeline: createHistory(), predictions: {} };
  let booted = false;

  function pushEvent(store, type, data) {
    const event = { at: new Date().toISOString(), type, data };
    store.events.push(event);
    if (store.events.length > 2500) store.events.shift();
    store.rev = (store.rev || 0) + 1;
    if (type === 'request') {
      if (data?.ok === false) pushMilestone(store.timeline, { at: event.at, kind: 'failure', text: `Request failure ${data.error || data.status || ''}`, detail: `Pod ${data.pod || 'unknown'} returned an error. Failures do not drive scaling directly; they signal overload or draining pods.`, observer: 'dashboard load client' });
      return event;
    }
    // Sampled successful requests and preStop markers feed the trace lanes;
    // they never become timeline milestones.
    if (type === 'sample' || type === 'prestop') return event;
    if (type === 'hpa' || type === 'cluster' || type === 'endpoint' || type === 'load' || type === 'action') {
      const d = data || {};
      if (type === 'action') pushMilestone(store.timeline, { at: event.at, kind: 'action', text: d.text || 'Learner action', detail: d.detail || '', observer: 'learner' });
      else if (type === 'load') pushMilestone(store.timeline, { at: event.at, kind: 'load', text: d.text || 'Load change', detail: `Offered traffic target is now ${d.rps ?? '?'} req/s. Prometheus observes this after its 5s scrape; HPA reacts later.`, observer: 'load controller' });
      else if (type === 'hpa') pushMilestone(store.timeline, { at: event.at, kind: 'hpa', text: d.text || 'HPA decision', detail: 'HPA desired replicas changed. Pod creation and readiness lag behind this decision.', observer: 'Kubernetes HPA' });
      else pushMilestone(store.timeline, { at: event.at, kind: type, text: d.text || type, detail: type === 'cluster' ? 'Pod created, became ready/terminating, or was removed. New pods must pass readiness before receiving traffic.' : 'Endpoint readiness changed; the Service only sends traffic to ready, non-terminating endpoints.', observer: type === 'cluster' ? 'kubelet / Deployment' : 'EndpointSlice controller' });
    }
    return event;
  }
  function emit(type, data) { return pushEvent(state, type, data); }
  function runEmit(run, type, data) { return pushEvent(run, type, { ...data, run: run.id }); }

  const load = io.loadFactory(emit, {});
  const loadState = () => load.state();
  const profilesPayload = () => ({
    request: Object.fromEntries(Object.entries(io.profiles.request).map(([k, v]) => [k, { minRps: v.minRps, maxRps: v.maxRps, step: v.step, phases: v.phases.map((p) => ({ label: p.label, rps: p.rps })) }])),
    cpu: Object.fromEntries(Object.entries(io.profiles.cpu).map(([k, v]) => [k, { minRps: v.minRps, maxRps: v.maxRps, step: v.step, path: v.path, phases: v.phases.map((p) => ({ label: p.label, rps: p.rps })) }])),
    durations: LOAD_DURATIONS,
  });

  function wireRunLoad(run) {
    run.load = io.loadFactory((t, d) => runEmit(run, t, d), { cpu: run.lesson === 'autoscale' });
    if (run.forwardPort) run.load.endpoint = `http://127.0.0.1:${run.forwardPort}`;
  }

  let sampling = false;
  async function sampleTimeline() {
    if (sampling) return;
    sampling = true;
    try {
      const [cluster, rate] = await Promise.all([io.clusterState(), io.promQuery(io.legacyRateQuery)]);
      if (!cluster.connected) return;
      const actual = cluster.pods.filter((p) => !p.terminating).length;
      const ready = cluster.pods.filter((p) => p.ready && !p.terminating).length;
      pushPoint(state.timeline, {
        offeredRps: load.active ? load.offeredLastSecond : 0,
        offeredTarget: load.active ? load.targetRps : 0,
        achievedRps: load.active ? load.achievedLastSecond : 0,
        observedRps: rate.value, observedAt: rate.at, stale: rate.stale,
        desired: cluster.hpa?.desired ?? null, actual, ready,
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
    for (const run of R.runs.values()) {
      if (run.status !== 'ready') continue;
      try {
        const [snap, rate] = await Promise.all([R.runClusterState(run.id), io.promQuery(io.rateQueryForRun(run.id))]);
        if (!snap.connected) continue;
        diffRunState(run, snap);
        let counter = { total: null, at: null, stalestAt: null, upAllOne: false, evaluatedAt: null, stale: true };
        let targets = { value: null, stale: true };
        if (run.lesson === 'prometheus') {
          [counter, targets] = await Promise.all([
            io.queryRunSamples(io.counterSelForRun(run.id), io.upSelForRun(run.id)).catch(() => counter),
            io.promQuery(io.upQueryForRun(run.id)).catch(() => targets),
          ]);
        }
        pushPoint(run.timeline, {
          offeredRps: run.load?.active ? run.load.offeredLastSecond : 0,
          offeredTarget: run.load?.active ? run.load.targetRps : 0,
          achievedRps: run.load?.active ? run.load.achievedLastSecond : 0,
          observedRps: rate.value, observedAt: rate.at, stale: rate.stale,
          counterTotal: counter.total, sampleAt: counter.at,
          scrapeTargets: targets.stale ? null : targets.value,
          scrapeOk: counter.upAllOne,
          desired: snap.hpa?.desired ?? null,
          currentCPU: snap.hpa?.currentCPU ?? null,
          cpuTarget: snap.hpa?.cpuTarget ?? null,
          externalCurrent: snap.hpa?.external?.current ?? null,
          externalRaw: snap.hpa?.external?.currentRaw ?? null,
          externalTarget: snap.hpa?.external?.target ?? null,
          externalName: snap.hpa?.external?.name ?? null,
          actual: snap.pods.filter((p) => !p.terminating).length,
          ready: snap.pods.filter((p) => p.ready && !p.terminating).length,
          terminating: snap.pods.filter((p) => p.terminating).length,
          endpoints: snap.endpoints.filter((e) => e.ready && !e.terminating).length,
          podsSnapshot: snap.pods.map((p) => ({ name: p.name, ready: Boolean(p.ready), terminating: Boolean(p.terminating) })),
          endpointsSnapshot: snap.endpoints.map((e) => ({ pod: e.pod, ready: Boolean(e.ready), terminating: Boolean(e.terminating) })),
        });
      } catch { /* skip this round for this run */ }
    }
  }

  function observeRun(run) {
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const now = await R.runClusterState(run.id);
        if (!now.connected) return;
        diffRunState(run, now);
      } finally { busy = false; }
    }, 750);
    return () => clearInterval(timer);
  }

  function observeCluster() {
    let previous = null, busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const now = await io.clusterState();
        if (!now.connected) return;
        if (previous) {
          const oldPods = new Map(previous.pods.map((x) => [x.name, x]));
          for (const pod of now.pods) {
            const old = oldPods.get(pod.name);
            if (!old) emit('cluster', { text: `${pod.name} created` });
            else if (old.terminating !== pod.terminating || old.ready !== pod.ready) emit('cluster', { text: `${pod.name}: ${pod.terminating ? 'terminating' : pod.ready ? 'ready' : 'not ready'}` });
            oldPods.delete(pod.name);
          }
          for (const name of oldPods.keys()) emit('cluster', { text: `${name} removed` });
          const oldEndpoints = new Map(previous.endpoints.map((x) => [x.pod, x]));
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
    R.validateRunId(id);
    return R.runs.get(id) || null;
  }

  function lessonProfiles(lesson) {
    return lesson === 'autoscale' ? io.profiles.cpu : io.profiles.request;
  }

  async function runLoadAction(run, action, profile, durationMs) {
    const session = run.load;
    if (!session) throw new Error(`Run ${run.id} is not ready for traffic yet.`);
    if (run.scenarioRunning) throw Object.assign(new Error('A scenario is running in this run. Stop it before manual load.'), { status: 409 });
    if (action === 'start') {
      if (run.actionRunning) throw Object.assign(new Error('A learner action is running in this run. Wait for it before manual load.'), { status: 409 });
      if (run.pendingLong) throw Object.assign(new Error('A guided long request is in flight. Terminate it before manual load.'), { status: 409 });
      if (session.active) throw Object.assign(new Error('A load session is already running for this run. Stop it before starting another.'), { status: 409 });
      const set = lessonProfiles(run.lesson);
      if (!profile || !Object.hasOwn(set, profile)) throw new Error(`Unknown profile for this lesson. Expected ${Object.keys(set).join(', ')}.`);
      await session.start(profile, { durationMs });
      await sampleRuns();
      return session.state();
    }
    if (!session.active) throw new Error('No active load session for this run.');
    if (action === 'increase') return session.increase();
    if (action === 'decrease') return session.decrease();
    return session.stop('stopped from UI');
  }

function summarizeAction(s) {
  if (!s || typeof s !== 'object') return '';
  if (s.shared !== undefined) return s.shared ? 'one shared edge connection' : 'distinct edge connections';
  if (s.allDistinct !== undefined) return s.allDistinct ? 'all fresh connections distinct' : 'some connections reused';
  if (s.clientReused !== undefined) return `client ${s.clientReused ? 'reused' : 'renewed'}, upstream ${s.upstream.after[0] === s.upstream.before[0] && s.upstream.after[1] === s.upstream.before[1] ? 'reused' : 'reconnected'}`;
  if (s.complete !== undefined) return s.complete ? `completed in ${s.ms}ms` : `interrupted (${s.error || 'no response'})`;
  if (s.pod && !s.complete && s.action?.startsWith('start')) return `serving pod ${s.pod}`;
  if (s.rolled) return 'rollout finished';
  if (s.profile) return `background ${s.profile} started`;
  if (s.total !== undefined) return `${s.total} background requests sent`;
  return s.action || '';
}

  function predictionScope(input) {
    if (input.run) {
      R.validateRunId(input.run);
      const run = R.runs.get(input.run);
      if (!run) throw Object.assign(new Error(`Unknown run: ${input.run}`), { status: 404 });
      return { key: `run:${input.run}`, lesson: run.lesson, run };
    }
    return { key: 'legacy', lesson: input.lesson || state.scenario || 'prometheus', run: null };
  }

  // Observation must come AFTER the prediction was recorded, and baseline
  // sampler points alone never count: only real experiment activity
  // (scenario, load, or learner action started after predicting) opens reveal.
  function scopeObservedSince(scope, sinceISO) {
    const t = Date.parse(sinceISO);
    if (!Number.isFinite(t)) return false;
    if (scope.run) {
      return Boolean(scope.run.experimentAt) && Date.parse(scope.run.experimentAt) >= t;
    }
    return Boolean(state.experimentAt) && Date.parse(state.experimentAt) >= t;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/api/state') {
      const legacy = state.predictions.legacy || null;
      return send(res, 200, { ...state, load: loadState(), profiles: profilesPayload(), runs: [...R.runs.values()].map(R.describeRun), archivedRuns: [...R.archives.keys()], maxActiveRuns: R.MAX_ACTIVE_RUNS, booted, legacyPrediction: legacy ? { guess: legacy.guess, lesson: legacy.lesson, revealed: legacy.revealed } : null });
    }
    if (req.method === 'GET' && path === '/api/cluster') return send(res, 200, await io.clusterState());
    // Managed local-only Grafana route (fixed service, ephemeral localhost
    // port). Never a generic proxy: only the provisioned Grafana service.
    // The run parameter is validated BEFORE starting any route, so unknown
    // runs never spawn a forward.
    if (req.method === 'GET' && path === '/api/grafana') {
      const runParam = url.searchParams.get('run');
      if (runParam) {
        try {
          R.validateRunId(runParam);
          if (!R.runs.has(runParam) && !R.archives.has(runParam)) throw new Error('unknown run');
        } catch {
          return send(res, 404, { error: `Unknown run: ${runParam}` });
        }
      }
      const status = await io.grafanaApi.status().catch(() => ({ available: false, baseUrl: null }));
      if (!status.available) return send(res, 200, { available: false, baseUrl: null, dashboardUrl: null });
      let runUrl = dashboardUrl(status.baseUrl);
      let embedUrl = null;
      if (runParam) {
        runUrl = dashboardUrl(status.baseUrl, runParam);
        embedUrl = panelEmbedUrl(status.baseUrl, runParam);
      }
      return send(res, 200, { available: true, baseUrl: status.baseUrl, dashboardUrl: dashboardUrl(status.baseUrl), runUrl, embedUrl });
    }
    if (req.method === 'GET' && path === '/api/load') return send(res, 200, loadState());
    if (req.method === 'GET' && path === '/api/timeline') return send(res, 200, state.timeline);
    if (req.method === 'GET' && path === '/api/evidence') {
      const runParam = url.searchParams.get('run');
      if (runParam) {
        try { R.validateRunId(runParam); } catch (error) { return send(res, 400, { error: error.message }); }
        const live = R.runs.get(runParam);
        if (live) return send(res, 200, R.buildArchive(live));
        const archived = R.archives.get(runParam);
        if (archived) return send(res, 200, archived);
        try {
          const file = await readFile(join(io.resultsDir, `archive-${runParam}.json`), 'utf8');
          return send(res, 200, JSON.parse(file));
        } catch {
          return send(res, 404, { error: `Unknown run: ${runParam}` });
        }
      }
      return send(res, 200, { scenario: state.scenario, started: state.started, result: state.result, error: state.error, load: loadState(), timeline: state.timeline, events: state.events });
    }
    if (req.method === 'GET' && path === '/api/runs') {
      return send(res, 200, [...R.runs.values()].map(R.describeRun));
    }
    if (req.method === 'POST' && path === '/api/runs') {
      if (!booted) return send(res, 503, { error: 'Dashboard is still starting (re-adoption in progress). Retry in a few seconds.' });
      let input;
      try { input = await readBody(req); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      if (!R.RUN_LESSONS.has(input.lesson)) return send(res, 400, { error: `Unknown run lesson. Expected one of ${[...R.RUN_LESSONS].join(', ')}.` });
      if (R.activeRuns().length >= R.MAX_ACTIVE_RUNS) return send(res, 409, { error: `Run limit reached (${R.MAX_ACTIVE_RUNS} active runs: ${R.activeRuns().map((r) => r.id).join(', ')}). Clean up a run before creating another.` });
      let run;
      try {
        run = R.beginRun(input.lesson, emit);
      } catch (error) {
        return send(res, error.status || 400, { error: error.message });
      }
      send(res, 202, { started: true, id: run.id, namespace: run.ns, status: run.status });
      R.finishRun(run, emit)
        .then(() => {
          wireRunLoad(run);
          emit('note', { text: `Run ${run.id} ready in ${run.ns}.` });
        })
        .catch((error) => emit('error', { text: `Run creation failed: ${error.message}` }));
      return;
    }
    const runMatch = path.match(/^\/api\/runs\/([A-Za-z0-9-]+)(\/(timeline|load|run|cluster|actions))?$/);
    if (runMatch) {
      let run;
      try { run = getRun(runMatch[1]); } catch (error) { return send(res, 400, { error: error.message }); }
      if (!run) return send(res, 404, { error: `Unknown run: ${runMatch[1]}` });
      const sub = runMatch[3];
      if (req.method === 'GET' && !sub) {
        const key = `run:${run.id}`;
        const pred = state.predictions[key];
        return send(res, 200, {
          ...R.describeRun(run), rev: run.rev || 0, events: run.events.slice(-200),
          predicted: Boolean(pred), revealed: Boolean(pred?.revealed), predictGuess: pred?.guess || null,
          observed: Boolean(run.experimentAt),
        });
      }
      if (req.method === 'GET' && sub === 'timeline') return send(res, 200, run.timeline);
      if (req.method === 'GET' && sub === 'cluster') return send(res, 200, await R.runClusterState(run.id));
      if (req.method === 'POST' && sub === 'run') {
        const valid = ['connections', 'timeouts', 'shutdown', 'rollout', 'streaming', 'autoscale', 'prometheus'];
        let input;
        try { input = await readBody(req); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
        if (!valid.includes(input.id)) return send(res, 400, { error: 'Unknown scenario' });
        if (input.id !== run.lesson) return send(res, 400, { error: `Scenario ${input.id} does not belong to run ${run.id} (lesson ${run.lesson}).` });
        if (run.status !== 'ready') return send(res, 409, { error: `Run ${run.id} is ${run.status}. Wait before running scenarios.` });
        if (run.scenarioRunning) return send(res, 409, { error: 'A scenario is already running in this run.' });
        if (run.actionRunning) return send(res, 409, { error: 'A learner action is running in this run. Wait for it before the one-click scenario.' });
        if (run.pendingLong) return send(res, 409, { error: 'A guided long request is in flight. Terminate it before the one-click scenario.' });
        if (run.load?.active) return send(res, 409, { error: 'Manual load is running in this run. Stop it before the one-click scenario.' });
        run.scenarioRunning = true;
        run.scenario = input.id;
        run.mode = input.mode;
        run.result = null;
        run.error = null;
        run.experimentAt = new Date().toISOString();
        send(res, 202, { started: true });
        const stopObs = observeRun(run);
        io.runScenario(input.id, {
          mode: input.mode, namespace: run.ns, endpoint: `http://127.0.0.1:${run.forwardPort}`,
          rateQuery: io.rateQueryForRun(run.id), upQuery: io.upQueryForRun(run.id),
        }, (t, d) => runEmit(run, t, d))
          .then((result) => { run.result = result; runEmit(run, 'result', { status: result.status }); })
          .catch((error) => { run.error = error.message; runEmit(run, 'error', { text: error.message }); })
          .finally(() => { run.scenarioRunning = false; stopObs(); });
        return;
      }
      if (req.method === 'POST' && sub === 'load') {
        try {
          const input = await readBody(req);
          if (!['start', 'increase', 'decrease', 'stop'].includes(input.action)) return send(res, 400, { error: 'Unknown load action. Expected start, increase, decrease, or stop.' });
          if (run.status !== 'ready') return send(res, 409, { error: `Run ${run.id} is ${run.status}. Wait before sending traffic.` });
          const out = await runLoadAction(run, input.action, input.profile, input.durationMs);
          if (input.action === 'start') run.experimentAt = new Date().toISOString();
          return send(res, 200, out);
        } catch (error) {
          return send(res, error.status || 400, { error: error.message });
        }
      }
      if (req.method === 'POST' && sub === 'actions') {
        try {
          const input = await readBody(req);
          if (run.status !== 'ready') return send(res, 409, { error: `Run ${run.id} is ${run.status}. Wait before learner actions.` });
          if (run.actionRunning) return send(res, 409, { error: 'Another learner action is running in this run. Wait for it.' });
          if (run.scenarioRunning) return send(res, 409, { error: 'A scenario is running in this run. Wait for it before learner actions.' });
          // Guided actions observe clean traffic, except the intentional
          // rollout background sequence (bg-start, bg-stop, trigger-rollout).
          if (!['bg-start', 'bg-stop', 'trigger-rollout'].includes(input.action) && run.load?.active) {
            return send(res, 409, { error: 'Manual load is running in this run. Stop it before learner actions (except the rollout traffic sequence).' });
          }
          run.actionRunning = true;
          try {
            const summary = await io.runAction(run, input.action, input, (t, d) => runEmit(run, t, d));
            run.actions = (run.actions || 0) + 1;
            run.experimentAt = new Date().toISOString();
            runEmit(run, 'action', { text: `${input.action}: ${summarizeAction(summary)}`, detail: JSON.stringify(summary).slice(0, 300), action: input.action });
            return send(res, 200, summary);
          } finally {
            run.actionRunning = false;
          }
        } catch (error) {
          return send(res, error.status || 400, { error: error.message });
        }
      }
      if (req.method === 'DELETE' && !sub) {
        if (run.status === 'deleted') return send(res, 409, { error: `Run ${run.id} is already deleted.` });
        // Preflight the same guards cleanupRun enforces, so a rejected
        // cleanup returns 409 immediately instead of a misleading 202.
        if (run.status === 'creating') return send(res, 409, { error: `Run ${run.id} is still being created. Wait before cleanup.` });
        if (run.scenarioRunning) return send(res, 409, { error: `Run ${run.id} has a scenario running. Wait for it before cleanup.` });
        if (run.actionRunning) return send(res, 409, { error: `Run ${run.id} has a learner action running. Wait for it before cleanup.` });
        if (run.pendingLong) return send(res, 409, { error: `Run ${run.id} has a long request in flight. Terminate it (terminate-serving) before cleanup.` });
        send(res, 202, { started: true, run: run.id, namespace: run.ns });
        R.cleanupRun(run.id, io.resultsDir)
          .then(() => emit('note', { text: `Run ${run.id} cleaned up (${run.ns} deleted). Evidence remains downloadable.` }))
          .catch((error) => emit('error', { text: `Run cleanup failed: ${error.message}` }));
        return;
      }
      return send(res, 405, { error: 'Method not allowed for this run resource.' });
    }
    if (req.method === 'POST' && path === '/api/predict') {
      try {
        const input = await readBody(req);
        if (!PREDICT_VALUES.has(input.guess)) return send(res, 400, { error: 'Unknown prediction value.' });
        const scope = predictionScope(input);
        state.predictions[scope.key] = { guess: input.guess, lesson: scope.lesson, at: new Date().toISOString(), revealed: false };
        return send(res, 200, { recorded: true, scope: scope.key });
      } catch (error) {
        return send(res, error.status || 400, { error: error.message });
      }
    }
    if (req.method === 'POST' && path === '/api/reveal') {
      try {
        const input = await readBody(req);
        const scope = predictionScope(input);
        const rec = state.predictions[scope.key];
        if (!rec) return send(res, 400, { error: 'Record a prediction first.' });
        if (!scopeObservedSince(scope, rec.at)) return send(res, 400, { error: 'Observe after predicting — run traffic or the experiment, then reveal the explanation.' });
        rec.revealed = true;
        let explanation = EXPLANATIONS[rec.lesson] || EXPLANATIONS.prometheus;
        if (rec.lesson === 'shutdown' && scope.run?.mode === 'abrupt') {
          explanation += ' This run used abrupt mode, so expect the long request interrupted and background errors possible — compare with a graceful run.';
        }
        return send(res, 200, { explanation });
      } catch (error) {
        return send(res, error.status || 400, { error: error.message });
      }
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
          await load.start(input.profile, { durationMs: input.durationMs });
          state.experimentAt = new Date().toISOString();
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
      try { io.resetApi.validateResetTarget(input.target); } catch (error) { return send(res, 400, { error: error.message }); }
      state.resetting = true;
      state.resetSteps = [];
      state.error = null;
      send(res, 202, { started: true, target: input.target });
      try {
        if (load.active) await load.stop('stopped by reset');
        const result = await io.resetApi.runReset(input.target, (type, data) => {
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
      Object.assign(state, { running: true, scenario: input.id, events: [], rev: 0, result: null, error: null, started: new Date().toISOString(), experimentAt: new Date().toISOString(), timeline: createHistory(), predictions: {} });
      send(res, 202, { started: true });
      const stopObservation = observeCluster();
      io.runScenario(input.id, { mode: input.mode }, emit)
        .then(result => { state.result = result; emit('result', { status: result.status }); })
        .catch(error => { state.error = error.message; emit('error', { text: error.message }); })
        .finally(() => { state.running = false; stopObservation(); sampleTimeline(); });
      return;
    }
    if (req.method === 'GET' && (path === '/' || path === '/ui' || path === '/ui/')) {
      try {
        const content = await readFile(join(root, 'dist', 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(content);
      } catch { send(res, 404, { error: 'Console not built. Run make ui-build.' }); }
      return;
    }
    if (req.method === 'GET' && (path.startsWith('/assets/') || path.startsWith('/ui/'))) {
      const rel = path.startsWith('/ui/') ? path.slice(4) : path.slice(1);
      if (!rel || rel.includes('..') || rel.includes('\0')) return send(res, 400, { error: 'Invalid path' });
      const contentType = rel.endsWith('.js') ? 'text/javascript' : rel.endsWith('.css') ? 'text/css' : rel.endsWith('.html') ? 'text/html' : rel.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
      try {
        const content = await readFile(join(root, 'dist', rel));
        res.writeHead(200, { 'content-type': `${contentType}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(content);
      } catch { send(res, 404, { error: 'Not found' }); }
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

  async function boot() {
    try {
      const { readdir } = await import('node:fs/promises');
      const names = await readdir(io.resultsDir).catch(() => []);
      for (const name of names) {
        const m = /^archive-([a-z0-9]{8})\.json$/.exec(name);
        if (!m || R.archives.has(m[1])) continue;
        try {
          const parsed = JSON.parse(await readFile(join(io.resultsDir, name), 'utf8'));
          if (parsed?.run === m[1]) R.archives.set(m[1], parsed);
        } catch { /* ignore corrupt files */ }
      }
      const adopted = await R.adoptOrphanRuns();
      for (const run of adopted) {
        if (run.status === 'ready') wireRunLoad(run);
        emit('note', { text: `Re-adopted run ${run.id} (${run.ns}): ${run.status}${run.error ? ' — ' + run.error : ''}. Previous in-memory events are gone; archive files persist.` });
      }
    } catch (error) {
      emit('error', { text: `Startup recovery failed: ${error.message}` });
    } finally {
      booted = true;
    }
  }

  if (io.enableSampler) setInterval(async () => { await sampleTimeline(); await sampleRuns(); }, 5000);

  // App-level close: HTTP server plus ONLY this process's Grafana forward.
  // Never touches clusters, namespaces, or anything else kubectl owns.
  function close(done) {
    try { io.grafanaApi.close(); } catch { /* ignore */ }
    if (typeof done === 'function') server.close(done);
    else return new Promise((resolve) => server.close(resolve));
  }

  return { server, state, boot, isBooted: () => booted, close };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { server, boot, close } = createApp();
  server.listen(4173, '127.0.0.1', () => console.log('Dashboard: http://127.0.0.1:4173'));
  const shutdown = () => close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  boot();
}
