import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { gradeConnections, gradeTimeout, gradeShutdown, gradeRollout, gradeStream } from './grade.mjs';

const runFile = promisify(execFile);
const base = 'http://127.0.0.1:8080';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function kubectl(...args) {
  const { stdout } = await runFile('kubectl', ['--context', 'kind-scaling-lab', '-n', 'scaling-lab', ...args], { timeout: 180000 });
  return stdout.trim();
}
export async function clusterState() {
  try {
    const [pods, endpoints, hpa] = await Promise.all([
      kubectl('get', 'pods', '-l', 'app=scaling-app', '-o', 'json'),
      kubectl('get', 'endpointslices', '-l', 'kubernetes.io/service-name=app', '-o', 'json'),
      kubectl('get', 'hpa', '-o', 'json').catch(() => null)
    ]);
    const p = JSON.parse(pods).items.map(x => ({
      name: x.metadata.name, phase: x.status.phase,
      ready: x.status.containerStatuses?.every(c => c.ready) || false,
      terminating: Boolean(x.metadata.deletionTimestamp)
    }));
    const e = JSON.parse(endpoints).items.flatMap(x => x.endpoints || []).map(x => ({
      pod: x.targetRef?.name, ready: x.conditions?.ready, terminating: x.conditions?.terminating
    }));
    const h = hpa && JSON.parse(hpa).items.find(x => x.spec?.scaleTargetRef?.name === 'app');
    return { connected: true, pods: p, endpoints: e, hpa: h && {
      name: h.metadata.name, current: h.status?.currentReplicas, desired: h.status?.desiredReplicas,
      metrics: (h.spec?.metrics || []).map(metric => ({ type: metric.type, resource: metric.resource?.name }))
    } };
  } catch (error) { return { connected: false, error: error.message, pods: [], endpoints: [] }; }
}

function startRequest(path, agent) {
  let onHeaders, onDone;
  const headers = new Promise(resolve => { onHeaders = resolve; });
  const done = new Promise(resolve => { onDone = resolve; });
  const started = Date.now();
  let headerSent = false;
  const req = http.get(`${base}${path}`, { agent, timeout: 30000 }, res => {
    headerSent = true;
    onHeaders({ pod: res.headers['x-pod'], edgeConnection: res.headers['x-edge-connection'], appConnection: res.headers['x-app-connection'], status: res.statusCode });
    const chunks = [];
    res.on('data', x => chunks.push(x));
    res.on('end', () => onDone({ ok: res.statusCode === 200, complete: true, status: res.statusCode, pod: res.headers['x-pod'], edgeConnection: res.headers['x-edge-connection'], appConnection: res.headers['x-app-connection'], ms: Date.now() - started, body: Buffer.concat(chunks).toString() }));
    res.on('error', error => onDone({ ok: false, complete: false, error: error.code || error.message, pod: res.headers['x-pod'], ms: Date.now() - started }));
  });
  req.on('timeout', () => req.destroy(new Error('request timeout')));
  req.on('error', error => {
    if (!headerSent) onHeaders({ error: error.code || error.message });
    onDone({ ok: false, complete: false, error: error.code || error.message, ms: Date.now() - started });
  });
  return { headers, done };
}

async function traffic(durationMs, path, emit, intervalMs = 120, emitEvery = 1) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 12 });
  const requests = [];
  let observed = 0;
  const until = Date.now() + durationMs;
  while (Date.now() < until) {
    const task = startRequest(path, agent).done.then(x => {
      if (++observed % emitEvery === 0 || !x.ok) emit('request', { pod: x.pod, ok: x.ok, status: x.status, error: x.error, ms: x.ms });
      return x;
    });
    requests.push(task);
    await sleep(intervalMs);
  }
  const results = await Promise.all(requests);
  agent.destroy();
  return results;
}

async function podNames() {
  const raw = await kubectl('get', 'pods', '-l', 'app=scaling-app', '-o', 'json');
  return JSON.parse(raw).items.filter(x => !x.metadata.deletionTimestamp).map(x => x.metadata.name);
}

async function waitStablePods(expected = 2, timeoutMs = 45000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const state = await clusterState();
    if (state.connected && state.pods.length === expected && state.pods.every(x => x.ready && !x.terminating)) return;
    await sleep(1000);
  }
  throw new Error('Application pods did not settle before the experiment');
}

function watchPodLogs(pod, emit) {
  const child = spawn('kubectl', ['--context', 'kind-scaling-lab', '-n', 'scaling-lab', 'logs', '-f', `pod/${pod}`], { stdio: ['ignore', 'pipe', 'ignore'] });
  let pending = '';
  child.stdout.on('data', chunk => {
    pending += chunk.toString();
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.event?.startsWith('shutdown-')) emit('app-signal', { text: `${entry.event} · ${entry.pod} · active ${entry.active}`, ...entry });
      } catch { /* ignore non-JSON kubectl output */ }
    }
  });
  return () => child.kill();
}

async function startPrometheusForward() {
  const child = spawn('kubectl', ['--context', 'kind-scaling-lab', '-n', 'scaling-lab', 'port-forward', '--address', '127.0.0.1', 'service/prometheus', ':9090'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Prometheus port-forward did not start')), 15000);
    let output = '';
    const inspect = chunk => {
      output += chunk.toString();
      const match = output.match(/Forwarding from 127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); reject(new Error(`Prometheus port-forward exited ${code}: ${output}`)); });
  }).catch(error => { child.kill(); throw error; });
  return { port, close: () => child.kill() };
}

async function prometheusValue(port, query) {
  const url = `http://127.0.0.1:${port}/api/v1/query?query=${encodeURIComponent(query)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Prometheus query failed with HTTP ${response.status}`);
  const data = await response.json();
  if (data.status !== 'success') throw new Error(`Prometheus query failed: ${data.error || data.status}`);
  const value = data.data?.result?.[0]?.value?.[1];
  return value == null ? null : Number(value);
}

const REQUEST_RATE_QUERY = 'sum(rate(scaling_lab_http_requests_total{job="scaling-app"}[30s]))';

export function requireAutoscaler(state, kind) {
  const hpa = state.hpa;
  if (kind === 'cpu' && hpa?.name === 'app' && hpa.metrics?.some(metric => metric.type === 'Resource' && metric.resource === 'cpu')) return;
  if (kind === 'prometheus' && hpa?.name === 'keda-hpa-app-prometheus' && hpa.metrics?.some(metric => metric.type === 'External')) return;
  throw new Error(kind === 'cpu'
    ? 'The CPU HPA is not active. Run make hpa-up before the CPU autoscaling lesson.'
    : 'The Prometheus KEDA HPA is not active. Run make prometheus-up before the Prometheus lesson.');
}

async function runPrometheusScenario(emit) {
  await kubectl('get', 'scaledobject', 'app-prometheus', '-o', 'name').catch(() => { throw new Error('Prometheus scaler is missing. Run make prometheus-up first.'); });
  await waitStablePods();
  const forward = await startPrometheusForward();
  try {
    let scrapeTargets = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      scrapeTargets = await prometheusValue(forward.port, 'count(up{job="scaling-app"} == 1)') ?? 0;
      if (scrapeTargets >= 2) break;
      await sleep(5000);
    }
    if (scrapeTargets < 2) throw new Error('Prometheus is not scraping both app pods yet. Check the prometheus targets page.');
    const initialState = await clusterState();
    requireAutoscaler(initialState, 'prometheus');
    const initial = initialState.pods.filter(x => !x.terminating).length;
    let peak = initial;
    let peakRps = 0;
    let monitoring = false;
    const sample = async () => {
      if (monitoring) return;
      monitoring = true;
      try {
        const [rps, state] = await Promise.all([prometheusValue(forward.port, REQUEST_RATE_QUERY), clusterState()]);
        peakRps = Math.max(peakRps, rps ?? 0);
        peak = Math.max(peak, state.pods.filter(x => !x.terminating).length);
        emit('prometheus', { rps, pods: state.pods.length, desired: state.hpa?.desired, text: `${rps == null ? 'warming up' : rps.toFixed(1) + ' req/s'} · ${state.pods.length} pods · desired ${state.hpa?.desired ?? '?'}` });
      } catch (error) { emit('note', { text: `Metric sample unavailable: ${error.message}` }); }
      finally { monitoring = false; }
    };
    emit('note', { text: `Prometheus is scraping ${scrapeTargets} app pods. Sending request load.` });
    const timer = setInterval(sample, 5000);
    const load = await traffic(80000, '/fast', emit, 30, 15);
    clearInterval(timer);
    await sample();
    emit('note', { text: `Load stopped. Peak observed rate ${peakRps.toFixed(1)} req/s; watching scale down.` });
    let stableDown = false;
    let final = peak;
    const drain = [];
    const until = Date.now() + 180000;
    while (Date.now() < until && !stableDown) {
      drain.push(...await traffic(5000, '/fast', emit, 500, 5));
      await sample();
      const state = await clusterState();
      final = state.pods.filter(x => !x.terminating).length;
      stableDown = state.pods.length === initial && state.pods.every(x => x.ready && !x.terminating);
    }
    const checks = [
      { pass: scrapeTargets >= 2, label: 'Prometheus scraped both starting app pods' },
      { pass: peakRps > 10, label: 'PromQL observed request demand above the 5 req/s per-pod target' },
      { pass: peak > initial, label: 'KEDA and HPA added app replicas under request load' },
      { pass: stableDown, label: 'Replicas returned to baseline after the request rate fell' },
      { pass: drain.length > 0 && drain.every(x => x.ok), label: 'Sampled requests succeeded during scale down' }
    ];
    return {
      status: checks.every(x => x.pass) ? 'pass' : 'fail',
      checks,
      evidence: { query: REQUEST_RATE_QUERY, thresholdRpsPerPod: 5, scrapeTargets, initial, peak, final, peakRps, loadRequests: load.length, loadFailures: load.filter(x => !x.ok).length, drainRequests: drain.length, drainFailures: drain.filter(x => !x.ok).slice(0, 10) }
    };
  } finally { forward.close(); }
}

export async function runScenario(id, options, emit) {
  emit('note', { text: `Starting ${id}` });
  if (id === 'connections') {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const reused = [];
    const fresh = [];
    for (let i = 0; i < 8; i++) {
      const r = await startRequest('/fast', agent).done;
      reused.push(r.edgeConnection);
      emit('request', { group: 'keep-alive', ...r, body: undefined });
    }
    agent.destroy();
    for (let i = 0; i < 8; i++) {
      const r = await startRequest('/fast', false).done;
      fresh.push(r.edgeConnection);
      emit('request', { group: 'new connection', ...r, body: undefined });
    }
    return gradeConnections(reused, fresh);
  }
  if (id === 'timeouts') {
    async function pair(gapMs) {
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      const first = await startRequest('/fast', agent).done;
      emit('request', { group: `${gapMs}ms idle`, ...first, body: undefined });
      await sleep(gapMs);
      const second = await startRequest('/fast', agent).done;
      emit('request', { group: `${gapMs}ms idle`, ...second, body: undefined });
      agent.destroy();
      return [first, second];
    }
    const shortGap = await pair(1000);
    const longGap = await pair(6500);
    return gradeTimeout(shortGap, longGap);
  }
  if (id === 'shutdown') {
    const mode = options.mode === 'abrupt' ? 'abrupt' : 'graceful';
    emit('note', { text: `Deploying ${mode} shutdown mode` });
    await kubectl('set', 'env', 'deployment/app', `SHUTDOWN_MODE=${mode}`);
    await kubectl('rollout', 'status', 'deployment/app', '--timeout=180s');
    await waitStablePods();
    const slowReq = startRequest('/slow?ms=8000', new http.Agent({ keepAlive: true }));
    const slowHeaders = await slowReq.headers;
    if (!slowHeaders.pod) throw new Error(`Long request did not reach a pod: ${slowHeaders.error}`);
    emit('slow-start', slowHeaders);
    const stopLogWatch = watchPodLogs(slowHeaders.pod, emit);
    const background = traffic(11000, '/fast', emit);
    await sleep(900);
    emit('pod-delete', { pod: slowHeaders.pod });
    await kubectl('delete', 'pod', slowHeaders.pod, '--wait=false');
    const slow = { ...await slowReq.done, pod: slowHeaders.pod };
    emit('slow-end', slow);
    const samples = await background;
    stopLogWatch();
    return gradeShutdown({ slow, samples, deletedPod: slowHeaders.pod, mode });
  }
  if (id === 'rollout') {
    await kubectl('set', 'env', 'deployment/app', 'SHUTDOWN_MODE=graceful');
    await kubectl('rollout', 'status', 'deployment/app', '--timeout=180s');
    await waitStablePods();
    const before = await podNames();
    const background = traffic(15000, '/fast', emit);
    await sleep(1000);
    emit('rollout', { text: 'Starting rolling update' });
    await kubectl('set', 'env', 'deployment/app', `LAB_REV=${Date.now()}`);
    await kubectl('rollout', 'status', 'deployment/app', '--timeout=180s');
    const samples = await background;
    const after = await podNames();
    return gradeRollout(samples, before, after);
  }
  if (id === 'streaming') {
    await kubectl('set', 'env', 'deployment/app', 'SHUTDOWN_MODE=graceful');
    await kubectl('rollout', 'status', 'deployment/app', '--timeout=180s');
    await waitStablePods();
    const streamRequest = startRequest('/stream', new http.Agent({ keepAlive: true }));
    const streamHeaders = await streamRequest.headers;
    if (!streamHeaders.pod) throw new Error(`Stream did not reach a pod: ${streamHeaders.error}`);
    emit('stream-start', streamHeaders);
    const stopLogWatch = watchPodLogs(streamHeaders.pod, emit);
    await sleep(1100);
    emit('pod-delete', { pod: streamHeaders.pod });
    await kubectl('delete', 'pod', streamHeaders.pod, '--wait=false');
    const stream = { ...await streamRequest.done, pod: streamHeaders.pod };
    emit('stream-end', { pod: stream.pod, complete: stream.complete, error: stream.error });
    stopLogWatch();
    return gradeStream({ stream, deletedPod: streamHeaders.pod });
  }
  if (id === 'autoscale') {
    const state = await clusterState();
    requireAutoscaler(state, 'cpu');
    const initial = state.pods.filter(x => !x.terminating).length;
    emit('note', { text: `Starting CPU load with ${initial} pods` });
    const samples = await traffic(75000, '/cpu?ms=120', emit, 150);
    const scaled = await clusterState();
    const peak = scaled.pods.filter(x => !x.terminating).length;
    emit('note', { text: `CPU load stopped at ${peak} pods; watching scale down` });
    let final = peak;
    let stableDown = false;
    const drainSamples = [];
    const until = Date.now() + 180000;
    while (Date.now() < until && !stableDown) {
      drainSamples.push(...await traffic(5000, '/fast', emit, 250));
      const current = await clusterState();
      final = current.pods.filter(x => !x.terminating).length;
      stableDown = current.pods.length === initial && current.pods.every(x => x.ready && !x.terminating);
      emit('hpa', { text: `Current ${final}, desired ${current.hpa?.desired ?? '?'} replicas` });
    }
    const grew = peak > initial;
    const shrank = grew && stableDown;
    const drainClean = drainSamples.length > 0 && drainSamples.every(x => x.ok);
    return {
      status: grew && shrank && drainClean ? 'pass' : 'fail',
      checks: [
        { pass: grew, label: 'HPA added replicas during CPU load' },
        { pass: shrank, label: 'HPA returned to the starting replica count after load ended' },
        { pass: drainClean, label: 'Sampled requests succeeded during scale down' }
      ],
      evidence: { initial, peak, final, stableDown, loadRequests: samples.length, loadFailures: samples.filter(x => !x.ok).length, drainRequests: drainSamples.length, drainFailures: drainSamples.filter(x => !x.ok).slice(0, 10) }
    };
  }
  if (id === 'prometheus') return runPrometheusScenario(emit);
  throw new Error('Unknown scenario');
}
