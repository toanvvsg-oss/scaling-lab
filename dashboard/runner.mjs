import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gradeConnections, gradeTimeout, gradeShutdown, gradeRollout, gradeStream, gradeCapacity, gradeHpaReact, gradePending, gradeResources, gradeSignals, gradeDownstream, gradeDisruptions, gradeGateway, gradeCapstone, percentile } from './grade.mjs';

const runFile = promisify(execFile);
const base = 'http://127.0.0.1:8080';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function kubectl(ns, ...args) {
  const { stdout } = await runFile('kubectl', ['--context', 'kind-scaling-lab', '-n', ns, ...args], { timeout: 180000 });
  return stdout.trim();
}
export const kubectlIn = (ns, ...args) => kubectl(ns, ...args);
export { startRequest, traffic, watchPodLogs };
// namespace defaults to scaling-lab so existing CLI lessons keep working.
export async function clusterState(ns = 'scaling-lab') {
  try {
    const [pods, endpoints, hpa] = await Promise.all([
      kubectl(ns, 'get', 'pods', '-l', 'app=scaling-app', '-o', 'json'),
      kubectl(ns, 'get', 'endpointslices', '-l', 'kubernetes.io/service-name=app', '-o', 'json'),
      kubectl(ns, 'get', 'hpa', '-o', 'json').catch(() => null)
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

function startRequest(path, agent, baseUrl = base, opts = {}) {
  const deadlineMs = Number(opts.deadlineMs ?? 35000);
  let onHeaders, onDone;
  const headers = new Promise(resolve => { onHeaders = resolve; });
  const done = new Promise(resolve => { onDone = resolve; });
  const started = Date.now();
  let headerSent = false;
  let settled = false;
  let responseInfo = {};
  const finish = (outcome) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    onDone(outcome);
  };
  const req = http.get(`${baseUrl}${path}`, { agent, timeout: 30000 }, res => {
    headerSent = true;
    responseInfo = { pod: res.headers['x-pod'], requestId: res.headers['x-request-id'], edgeConnection: res.headers['x-edge-connection'], appConnection: res.headers['x-app-connection'], status: res.statusCode };
    onHeaders(responseInfo);
    const chunks = [];
    res.on('data', x => chunks.push(x));
    res.on('end', () => finish({ ok: res.statusCode === 200, complete: true, status: res.statusCode, pod: res.headers['x-pod'], requestId: res.headers['x-request-id'], edgeConnection: res.headers['x-edge-connection'], appConnection: res.headers['x-app-connection'], ms: Date.now() - started, body: Buffer.concat(chunks).toString() }));
    res.on('error', error => finish({ ...responseInfo, ok: false, complete: false, error: error.code || error.message, ms: Date.now() - started }));
    // A connection that closes mid-body without end/error (pod deleted
    // mid-response, proxy FIN) must still settle: otherwise traffic's
    // Promise.all waits forever and the scenario never reaches restore.
    // finish() is settled-guarded, so the normal end/error path always wins.
    res.on('close', () => finish({ ...responseInfo, ok: false, complete: false, error: responseInfo.error || 'connection closed mid-response', ms: Date.now() - started }));
  });
  // Absolute deadline: socket inactivity timeouts alone cannot bound a
  // slowly-dribbling response, and req.destroy() alone does not settle a
  // request still queued in the agent (Node may emit the error only once a
  // socket is assigned). So the deadline explicitly settles both promises
  // once — preserving response identity when headers arrived — then aborts.
  // Every startRequest settles by ~deadline, which bounds traffic()'s join
  // and every scenario wait above it.
  const deadline = setTimeout(() => {
    if (!headerSent) onHeaders({ error: 'request deadline exceeded' });
    finish({ ...responseInfo, ok: false, complete: false, error: 'request deadline exceeded', ms: Date.now() - started });
    try { req.destroy(new Error('request deadline exceeded')); } catch { /* already gone */ }
  }, Math.max(1, deadlineMs));
  req.on('timeout', () => req.destroy(new Error('request timeout')));
  req.on('error', error => {
    if (!headerSent) onHeaders({ error: error.code || error.message });
    finish({ ...responseInfo, ok: false, complete: false, error: error.code || error.message, ms: Date.now() - started });
  });
  return { headers, done };
}

async function traffic(durationMs, path, emit, intervalMs = 120, emitEvery = 1, baseUrl = base, cancel = null, probe = null) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 12 });
  const requests = [];
  let observed = 0;
  const until = Date.now() + durationMs;
  // Generation (offering) ends when the loop exits — normally, by stop, or by
  // error — strictly before the drain join below. The probe records that
  // boundary so coverage can tell offered load apart from delayed completion.
  let generationEnded = false;
  const endGeneration = () => { if (probe && !generationEnded) { generationEnded = true; probe.stopped(Date.now()); } };
  try {
    while (Date.now() < until) {
      throwIfCancelled(cancel);
      if (probe) probe.offered(Date.now());
      const task = startRequest(path, agent, baseUrl).done.then(x => {
        const n = ++observed;
        // Successful samples go to the trace as 'sample' (no milestone);
        // failures keep the 'request' type so they milestone.
        if (x.ok && (n % emitEvery === 0)) emit('sample', { pod: x.pod, ok: true, ms: x.ms, requestId: x.requestId, edgeConnection: x.edgeConnection, appConnection: x.appConnection });
        else if (!x.ok) emit('request', { pod: x.pod, ok: x.ok, status: x.status, error: x.error, ms: x.ms, requestId: x.requestId });
        return x;
      });
      requests.push(task);
      await sleep(intervalMs);
    }
    endGeneration();
    return await Promise.all(requests);
  } catch (error) {
    endGeneration();
    throw error;
  } finally {
    // Cancellation or error rejects the loop above WITHOUT joining
    // outstanding requests. Settle them here — each startRequest is
    // deadline-bounded, so this drain is bounded — before releasing sockets,
    // so a caller awaiting this promise observes actual settlement, and a
    // wedged connection can never leak an agent socket in the long-lived
    // dashboard server.
    await Promise.allSettled(requests);
    agent.destroy();
  }
}

export const CANCELLED = 'CANCELLED';
export function throwIfCancelled(cancel) {
  if (typeof cancel === 'function' && cancel()) {
    throw Object.assign(new Error('cancelled by End lesson'), { code: CANCELLED });
  }
}

// Race a long blocking promise against cancellation. On cancel the caller
// stops waiting; the orphaned operation runs out on its own (read-only status
// waits) or is finalized by namespace deletion. Never swallows the outcome
// when not cancelled.
export async function unlessCancelled(promise, cancel, pollMs = 1000) {
  if (typeof cancel !== 'function') return promise;
  let settled = false;
  let value;
  let error = null;
  promise.then((v) => { settled = true; value = v; }, (e) => { settled = true; error = e; });
  while (!settled) {
    throwIfCancelled(cancel);
    await sleep(Math.min(pollMs, 1000));
  }
  if (error) throw error;
  return value;
}

// Scalers fight manual replica control, so scenarios that need fixed counts
// remove them first and remember what existed. Restore is shared-namespace
// only: run namespaces are provisioned scaler-free on purpose.
async function removeScalers(ns) {
  const hadHpa = await kubectl(ns, 'get', 'hpa', 'app', '-o', 'name').then(() => true).catch(() => false);
  const hadSO = await kubectl(ns, 'get', 'scaledobject', 'app-prometheus', '-o', 'name').then(() => true).catch(() => false);
  await kubectl(ns, 'delete', 'hpa', '--all', '--ignore-not-found');
  await kubectl(ns, 'delete', 'scaledobject', '--all', '--ignore-not-found');
  return { hadHpa, hadSO };
}

async function restoreScalers(ns, had, emit) {
  if (ns !== 'scaling-lab') return;
  if (!had.hadHpa && !had.hadSO) return;
  try {
    const k8sDir = new URL('../k8s/', import.meta.url);
    if (had.hadHpa) await kubectl(ns, 'apply', '-f', fileURLToPath(new URL('hpa.yaml', k8sDir)));
    if (had.hadSO) await kubectl(ns, 'apply', '-f', fileURLToPath(new URL('prometheus-scaledobject.yaml', k8sDir)));
    emit('note', { text: `Pre-existing scaler(s) re-applied (hpa=${had.hadHpa}, scaledobject=${had.hadSO}).` });
  } catch (error) {
    emit('error', { text: `Scaler restore FAILED: ${error.message}. Run make hpa-up or make prometheus-up.` });
  }
}

async function podNames(ns = 'scaling-lab') {
  const raw = await kubectl(ns, 'get', 'pods', '-l', 'app=scaling-app', '-o', 'json');
  return JSON.parse(raw).items.filter(x => !x.metadata.deletionTimestamp).map(x => x.metadata.name);
}

async function waitStablePods(ns = 'scaling-lab', expected = 2, timeoutMs = 45000, cancel = null) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    throwIfCancelled(cancel);
    const state = await clusterState(ns);
    if (state.connected && state.pods.length === expected && state.pods.every(x => x.ready && !x.terminating)) return;
    await sleep(1000);
  }
  throw new Error('Application pods did not settle before the experiment');
}

function watchPodLogs(pod, emit, ns = 'scaling-lab') {
  const child = spawn('kubectl', ['--context', 'kind-scaling-lab', '-n', ns, 'logs', '-f', `pod/${pod}`], { stdio: ['ignore', 'pipe', 'ignore'] });
  let pending = '';
  child.stdout.on('data', chunk => {
    pending += chunk.toString();
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      const pre = /^prestop-(start|end)\b.*$/.exec(line.trim());
      if (pre) { emit('prestop', { text: `preStop ${pre[1]} · ${pod}`, phase: pre[1], pod }); continue; }
      try {
        const entry = JSON.parse(line);
        if (entry.event?.startsWith('shutdown-')) emit('app-signal', { text: `${entry.event} · ${entry.pod} · active ${entry.active}`, ...entry });
        else if (entry.event?.startsWith('prestop-')) emit('prestop', { text: `${entry.event} · ${entry.pod || pod} · ${entry.at || ''}`, phase: entry.event.replace('prestop-', ''), pod: entry.pod || pod, at: entry.at });
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

const REQUEST_RATE_QUERY = 'sum(rate(scaling_lab_http_requests_total{job="scaling-app",namespace="scaling-lab"}[30s]))';
// Legacy-namespace scrape check: namespace label keeps CLI verification scoped
// to scaling-lab when run namespaces add more scaling-app targets.
const SCRAPE_UP_QUERY = 'count(up{job="scaling-app",namespace="scaling-lab"} == 1)';

export function requireAutoscaler(state, kind) {
  const hpa = state.hpa;
  if (kind === 'cpu' && hpa?.name === 'app' && hpa.metrics?.some(metric => metric.type === 'Resource' && metric.resource === 'cpu')) return;
  if (kind === 'prometheus' && hpa?.name === 'keda-hpa-app-prometheus' && hpa.metrics?.some(metric => metric.type === 'External')) return;
  throw new Error(kind === 'cpu'
    ? 'The CPU HPA is not active. Run make hpa-up before the CPU autoscaling lesson.'
    : 'The Prometheus KEDA HPA is not active. Run make prometheus-up before the Prometheus lesson.');
}

export const CAPACITY_WORK = {
  cheap: { label: 'cheap requests (/fast)', path: '/fast', rates: [5, 10, 15, 20, 30] },
  expensive: { label: 'expensive CPU work (/cpu?ms=250)', path: '/cpu?ms=250', rates: [2, 4, 6, 8, 10] },
};
export const CAPACITY_STEP_MS = 12000;
export const CAPACITY_TIMEOUT_MS = 5000;
export const CAPACITY_MAX_INFLIGHT = 64;

export function validateCapacityOptions(input = {}) {
  const work = input.work === 'expensive' ? 'expensive' : 'cheap';
  const sloP95Ms = Number(input.sloP95Ms ?? 500);
  const sloErrorPct = Number(input.sloErrorPct ?? 5);
  if (!Number.isFinite(sloP95Ms) || sloP95Ms < 50 || sloP95Ms > 10000) throw new Error('sloP95Ms must be between 50 and 10000.');
  if (!Number.isFinite(sloErrorPct) || sloErrorPct < 0 || sloErrorPct > 50) throw new Error('sloErrorPct must be between 0 and 50.');
  return { work, sloP95Ms, sloErrorPct };
}

// Milestone 5 capacity challenge (Q5.1): a FIXED workload/objective the
// learner must size headroom against — not a tunable. The estimate and
// headroom choice live in the learner's diagnosis report (never auto-graded);
// the only machine-observable requirement is that any cited rate comes from
// a generator-clean step (gradeCapacity already reports generatorLimited per
// step). The returned variant is what the diagnosis report records so the
// challenge reproduces exactly.
export const CAPACITY_CHALLENGE = {
  work: 'expensive',
  sloP95Ms: 500,
  sloErrorPct: 5,
  prompt: 'Expensive CPU work (/cpu?ms=250) must hold p95 ≤ 500ms with errors ≤ 5%. State a defensible per-pod capacity estimate, choose explicit headroom, and size pods for the stated peak — then show that every rate you cite is generator-clean (no dropped offers, no missed slots). A generator-limited step measures the generator, never the service.',
};

export function challengeVariantForCapacity() {
  return { kind: 'capacity-challenge', config: validateCapacityOptions(CAPACITY_CHALLENGE) };
}

function capacityRequest(path, baseUrl, timeoutMs, agent) {
  return new Promise((resolve) => {
    const started = Date.now();
    const deadline = started + timeoutMs;
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(kill); resolve(r); } };
    const req = http.get(`${baseUrl}${path}`, { agent, timeout: timeoutMs }, (res) => {
      // Drain without retaining: bodies are unused and must not accumulate.
      res.resume();
      res.on('end', () => done({ ok: res.statusCode === 200, complete: true, status: res.statusCode, ms: Date.now() - started, pod: res.headers['x-pod'] }));
      res.on('error', (error) => done({ ok: false, complete: false, status: res.statusCode ?? null, ms: Date.now() - started, error: error.code || error.message }));
    });
    // Absolute per-request deadline: socket inactivity timeouts alone cannot
    // bound a slowly-dribbling response, so destroy at started+timeoutMs.
    const kill = setTimeout(() => req.destroy(new Error('request deadline exceeded')), Math.max(1, deadline - Date.now()));
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    req.on('error', (error) => done({ ok: false, complete: false, status: null, ms: Date.now() - started, error: error.code || error.message, timeout: /timeout|deadline exceeded/i.test(error.message) }));
  });
}

async function topSnapshot(ns) {
  try {
    const raw = await kubectl(ns, 'top', 'pods', '-l', 'app=scaling-app', '--no-headers');
    const cpus = [];
    for (const line of raw.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const m = /^([0-9]+)m?$/.exec(parts[1]);
        if (m) cpus.push(parts[1].endsWith('m') ? Number(m[1]) : Number(m[1]) * 1000);
      }
    }
    if (!cpus.length) return null;
    return { pods: cpus.length, avgCpuMillicores: Math.round(cpus.reduce((a, b) => a + b, 0) / cpus.length) };
  } catch { return null; }
}

async function runCapacityScenario(emit, opts = {}) {
  const ns = opts.namespace || 'scaling-lab';
  const baseUrl = opts.endpoint || base;
  const { work, sloP95Ms, sloErrorPct } = validateCapacityOptions(opts.options);
  const spec = CAPACITY_WORK[work];
  const depRaw = await kubectl(ns, 'get', 'deployment/app', '-o', 'json');
  const dep = JSON.parse(depRaw);
  const container = dep.spec?.template?.spec?.containers?.[0] || {};
  const config = {
    replicas: 1, work: spec.label, path: spec.path,
    resources: container.resources || null,
    image: container.image || null,
    stepMs: CAPACITY_STEP_MS, requestTimeoutMs: CAPACITY_TIMEOUT_MS, maxInflight: CAPACITY_MAX_INFLIGHT,
  };
  emit('note', { text: `Capacity sweep (${spec.label}) on exactly one pod; autoscaling disabled. Objective: p95 ≤ ${sloP95Ms}ms, errors ≤ ${sloErrorPct}%.` });
  const removed = await removeScalers(ns);
  try {
  if (dep.spec?.replicas !== 1) {
    await kubectl(ns, 'scale', 'deployment/app', '--replicas=1');
  }
  await waitStablePods(ns, 1, 90000, opts.cancel || null);
  const agent = new http.Agent({ keepAlive: true, maxSockets: CAPACITY_MAX_INFLIGHT });
  const steps = [];
  for (const rate of spec.rates) {
    const lat = [];
    let offered = 0, started = 0, dropped = 0, completed = 0, failed = 0, timeouts = 0, timely = 0;
    let inflight = 0, peakInflight = 0, missedSlots = 0, maxLateMs = 0;
    const pending = new Set();
    const until = Date.now() + CAPACITY_STEP_MS;
    let n = 0;
    const stepStart = Date.now();
    const stepStartedAt = new Date(stepStart).toISOString();
    const intervalMs = 1000 / rate;
    while (Date.now() < until) {
      throwIfCancelled(opts.cancel);
      n += 1;
      offered += 1;
      const scheduledAt = stepStart + n * intervalMs;
      const lateMs = Date.now() - scheduledAt;
      // Loop-lateness diagnostic: how far behind schedule this offer ran.
      // Actual missed slots are the end-of-step shortfall below, so a merely
      // late (but still offered) slot is never double-counted as missed.
      if (lateMs > 0) maxLateMs = Math.max(maxLateMs, Math.round(lateMs));
      // Offer independently of completion, but never exceed the explicit
      // laptop bound: excess offers are counted as dropped, never hidden.
      if (inflight >= CAPACITY_MAX_INFLIGHT) {
        dropped += 1;
      } else {
        started += 1;
        inflight += 1;
        peakInflight = Math.max(peakInflight, inflight);
        const task = capacityRequest(spec.path, baseUrl, CAPACITY_TIMEOUT_MS, agent).then((r) => {
          inflight -= 1;
          pending.delete(task);
          if (r.complete && r.ok) { completed += 1; lat.push(r.ms); if (r.ms <= sloP95Ms) timely += 1; }
          else { failed += 1; if (r.timeout) timeouts += 1; }
          if ((completed + failed) % 25 === 0) emit('sample', { pod: r.pod, ok: r.ok, ms: r.ms });
          else if (!r.ok) emit('request', { pod: r.pod, ok: false, status: r.status, error: r.error, ms: r.ms });
          return r;
        });
        pending.add(task);
      }
      const waitUntil = stepStart + (n * 1000) / rate;
      const delay = waitUntil - Date.now();
      if (delay > 0) await sleep(Math.min(delay, 1000));
    }
    await Promise.all([...pending]);
    const stepFinishedAt = new Date().toISOString();
    const elapsedMs = Date.now() - stepStart;
    // Missed offered slots: schedule demanded floor(elapsed/interval) offers;
    // any shortfall means the generator did not sustain the configured rate,
    // even when the inflight cap never tripped.
    missedSlots = Math.max(0, Math.floor(elapsedMs / intervalMs) - offered);
    lat.sort((a, b) => a - b);
    const total = completed + failed;
    const top = await topSnapshot(ns);
    const step = {
      rate, startedAt: stepStartedAt, finishedAt: stepFinishedAt, elapsedMs,
      offered, started, dropped, completed, failed, timeouts, timely,
      missedSlots, maxLateMs, peakInflight,
      generatorLimited: dropped > 0 || missedSlots > 0,
      successRps: Math.round((completed / (elapsedMs / 1000)) * 10) / 10,
      goodputRps: Math.round((timely / (elapsedMs / 1000)) * 10) / 10,
      p50: percentile(lat, 50), p95: percentile(lat, 95), p99: percentile(lat, 99),
      errorPct: total ? Math.round((failed / total) * 1000) / 10 : 100,
      cpu: top,
    };
    steps.push(step);
    emit('note', { text: `${rate} RPS offered over ${(elapsedMs / 1000).toFixed(1)}s: success ${step.successRps}/s, timely (≤${sloP95Ms}ms) goodput ${step.goodputRps}/s, p50/p95/p99 ${step.p50 ?? '?'}/${step.p95 ?? '?'}/${step.p99 ?? '?'}ms, errors ${step.errorPct}% (failed ${failed}, timeouts ${timeouts}, dropped ${dropped}, missed ${missedSlots}, peak inflight ${peakInflight})${top ? `, pod CPU ~${top.avgCpuMillicores}m` : ''}.` });
  }
  } finally {
    agent.destroy();
    await restoreScalers(ns, removed, emit);
  }
  return gradeCapacity({ steps, config, sloP95Ms, sloErrorPct, plannedRates: spec.rates });
}

export function validateHpaReactOptions(input = {}) {
  const predictDesired = Number(input.predictDesired ?? 4);
  if (!Number.isInteger(predictDesired) || predictDesired < 2 || predictDesired > 8) {
    throw new Error('predictDesired must be an integer between 2 and 8.');
  }
  return { predictDesired };
}

export function validateCapstoneOptions(input = {}) {
  const sloP95Ms = Number(input.sloP95Ms ?? 800);
  const sloErrorPct = Number(input.sloErrorPct ?? 5);
  const mix = input.mix === 'cpu-heavy' || input.mix === 'io-heavy' ? input.mix : 'balanced';
  if (!Number.isFinite(sloP95Ms) || sloP95Ms < 100 || sloP95Ms > 5000) throw new Error('sloP95Ms must be between 100 and 5000.');
  if (!Number.isFinite(sloErrorPct) || sloErrorPct < 0 || sloErrorPct > 20) throw new Error('sloErrorPct must be between 0 and 20.');
  const minReplicas = Number(input.minReplicas ?? 2);
  const maxReplicas = Number(input.maxReplicas ?? 5);
  const cpuTarget = Number(input.cpuTarget ?? 60);
  if (!Number.isInteger(minReplicas) || minReplicas < 1 || minReplicas > 5) throw new Error('minReplicas must be an integer between 1 and 5.');
  if (!Number.isInteger(maxReplicas) || maxReplicas < 1 || maxReplicas > 8) throw new Error('maxReplicas must be an integer between 1 and 8.');
  if (maxReplicas < minReplicas) throw new Error('maxReplicas must be greater than or equal to minReplicas.');
  if (!Number.isInteger(cpuTarget) || cpuTarget < 30 || cpuTarget > 90) throw new Error('cpuTarget must be an integer between 30 and 90.');
  if (typeof input.rationale !== 'string') throw new Error('rationale is required: state briefly why these HPA bounds fit the objective.');
  const rationale = input.rationale.trim();
  if (!rationale) throw new Error('rationale is required: state briefly why these HPA bounds fit the objective.');
  if (rationale.length > 500) throw new Error('rationale must be at most 500 characters.');
  return { sloP95Ms, sloErrorPct, mix, minReplicas, maxReplicas, cpuTarget, rationale };
}

// Direct cgroup CPU-throttling readout (lesson 09): nr_throttled and
// throttled_usec from the pod's own cpu.stat. Never inferred from latency.
export async function cpuThrottle(ns, pod) {
  for (const path of ['/sys/fs/cgroup/cpu.stat', '/sys/fs/cgroup/cpu/cpu.stat']) {
    try {
      const raw = await kubectl(ns, 'exec', pod, '--', 'cat', path);
      const stat = {};
      for (const line of raw.split('\n')) {
        const [k, v] = line.trim().split(/\s+/);
        if (k && v != null && Number.isFinite(Number(v))) stat[k] = Number(v);
      }
      if (stat.nr_periods != null) {
        return { path, periods: stat.nr_periods, throttled: stat.nr_throttled ?? 0, throttledUsec: stat.throttled_usec ?? 0, usageUsec: stat.usage_usec ?? null };
      }
    } catch { /* try the next layout */ }
  }
  return null;
}


// Offered-rate load with settled accounting, reused by the post-capacity
// scenarios. Offers at a fixed rate independent of completion; excess beyond
// the inflight cap is counted dropped, never hidden.
export async function pacedRequests(baseUrl, path, rps, durationMs, timeoutMs, emit, opts = {}) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: opts.maxInflight || 64 });
  const lat = [];
  const statusCounts = {};
  let offered = 0, started = 0, dropped = 0, completed = 0, failed = 0, timeouts = 0, shed = 0;
  let inflight = 0, peakInflight = 0, missedSlots = 0;
  const pending = new Set();
  const until = Date.now() + durationMs;
  const stepStart = Date.now();
  let n = 0;
  try {
    while (Date.now() < until) {
      throwIfCancelled(opts.cancel);
      const missed = Math.max(0, Math.floor((Date.now() - stepStart - n * 1000 / rps) / (1000 / rps)));
      n += missed;
      missedSlots += missed;
      offered += missed;
      dropped += missed;
      n += 1;
      offered += 1;
      if (inflight >= (opts.maxInflight || 64)) {
        dropped += 1;
      } else {
        started += 1;
        inflight += 1;
        peakInflight = Math.max(peakInflight, inflight);
        const task = capacityRequest(path, baseUrl, timeoutMs, agent).then((r) => {
          inflight -= 1;
          pending.delete(task);
          statusCounts[r.status ?? 'none'] = (statusCounts[r.status ?? 'none'] || 0) + 1;
          if (r.complete && r.ok) { completed += 1; lat.push(r.ms); }
          else { failed += 1; if (r.timeout) timeouts += 1; }
          if (opts.countShed && r.status === 502) shed += 1;
          if ((completed + failed) % 25 === 0) emit('sample', { pod: r.pod, ok: r.ok, ms: r.ms });
          else if (!r.ok) emit('request', { pod: r.pod, ok: false, status: r.status, error: r.error, ms: r.ms });
          return r;
        });
        pending.add(task);
      }
      const delay = stepStart + (n * 1000) / rps - Date.now();
      if (delay > 0) await sleep(Math.min(delay, 1000));
    }
    await Promise.all([...pending]);
  } finally {
    agent.destroy();
  }
  const elapsedMs = Date.now() - stepStart;
  lat.sort((a, b) => a - b);
  return { offered, started, dropped, missedSlots, completed, failed, timeouts, shed, statusCounts, lat, peakInflight, elapsedMs };
}

export function summarizePaced(p, sloP95Ms) {
  const timely = p.lat.filter((ms) => ms <= sloP95Ms).length;
  const total = p.completed + p.failed;
  return {
    offered: p.offered, started: p.started, missedSlots: p.missedSlots, completed: p.completed, failed: p.failed, timeouts: p.timeouts, shed: p.shed,
    dropped: p.dropped, peakInflight: p.peakInflight, elapsedMs: p.elapsedMs, statusCounts: p.statusCounts,
    successRps: Math.round((p.completed / (p.elapsedMs / 1000)) * 10) / 10,
    timelyRps: Math.round((timely / (p.elapsedMs / 1000)) * 10) / 10,
    p50: percentile(p.lat, 50), p95: percentile(p.lat, 95), p99: percentile(p.lat, 99),
    errorPct: total ? Math.round((p.failed / total) * 1000) / 10 : 100,
  };
}

async function hpaSnapshot(ns) {
  const raw = await kubectl(ns, 'get', 'hpa', 'app', '-o', 'json');
  const h = JSON.parse(raw);
  const cpuSpec = (h.spec?.metrics || []).find((m) => m.type === 'Resource' && m.resource?.name === 'cpu');
  const cpuCur = (h.status?.currentMetrics || []).find((m) => m.type === 'Resource' && m.resource?.name === 'cpu');
  return {
    desired: h.status?.desiredReplicas ?? null,
    current: h.status?.currentReplicas ?? null,
    target: cpuSpec?.resource?.target?.averageUtilization ?? null,
    currentCPU: cpuCur?.resource?.current?.averageUtilization ?? null,
  };
}

export async function readyPods(ns) {
  const state = await clusterState(ns);
  return state.pods.filter((p) => p.ready && !p.terminating).length;
}

async function sampleHpa(ns, emit, label, phase) {
  const [snap, ready] = await Promise.all([hpaSnapshot(ns), readyPods(ns)]);
  const missing = snap.currentCPU == null;
  emit('hpa', { text: `${label}: desired ${snap.desired ?? '?'} · ready ${ready} · CPU ${snap.currentCPU ?? 'missing'}%/60%${missing ? ' (metric missing: controller holds, prediction is approximate)' : ''}` });
  return { at: new Date().toISOString(), phase, desired: snap.desired, ready, currentCPU: snap.currentCPU, missingMetric: missing };
}

async function runHpaReactScenario(emit, opts = {}) {
  const ns = opts.namespace || 'scaling-lab';
  const baseUrl = opts.endpoint || base;
  const { predictDesired } = validateHpaReactOptions(opts.options);
  const hcancel = opts.cancel || null;
  const snap0 = await hpaSnapshot(ns).catch(() => { throw new Error('The CPU HPA is not active in this run. Create a fresh hpareact run (it provisions its own HPA).'); });
  const ready0 = await readyPods(ns);
  const baseline = { target: snap0.target, replicas: snap0.current ?? ready0, desired: snap0.desired, currentCPU: snap0.currentCPU };
  emit('note', { text: `Baseline: target ${baseline.target}% with ${baseline.replicas} replicas (desired ${baseline.desired ?? '?'}). Prediction: burst drives desired to ${predictDesired}. Formula: ceil(replicas × observed/target), then tolerance, readiness, bounds, stabilization.` });
  // Phase 1: brief CPU burst. Sample fast (15 x 3s) so the genuine HPA
  // scale-out lag — desired bump first, Ready pods catching up — is caught
  // with timestamps instead of being averaged away.
  const series = [];
  emit('note', { text: 'Phase 1 (hpa-scale-out): 45s CPU burst — watch observed metric, desired replicas, and Ready pods separate.' });
  const burst = traffic(45000, '/cpu?ms=120', emit, 150, 5, baseUrl, hcancel);
  let firstBumpAt = null, allReadyAt = null;
  for (let i = 0; i < 15; i++) {
    throwIfCancelled(hcancel);
    await unlessCancelled(sleep(3000), hcancel);
    const s = await sampleHpa(ns, emit, `burst+${(i + 1) * 3}s`, 'hpa-scale-out');
    series.push(s);
    if (firstBumpAt == null && (s.desired ?? 0) > (baseline.desired ?? 2)) firstBumpAt = s.at;
    if (firstBumpAt != null && allReadyAt == null && (s.ready ?? 0) >= (s.desired ?? 0) && (s.desired ?? 0) > 0) allReadyAt = s.at;
  }
  await burst;
  const scaleOutLagSec = firstBumpAt && allReadyAt
    ? Math.round((Date.parse(allReadyAt) - Date.parse(firstBumpAt)) / 1000)
    : null;
  if (firstBumpAt) emit('note', { text: `HPA desired first exceeded baseline at ${firstBumpAt}; Ready caught up at ${allReadyAt ?? 'not within the burst window'}${scaleOutLagSec != null ? ` (scale-out lag ~${scaleOutLagSec}s)` : ''}.` });
  // Phase 2: bounded slow startup as a TEMPLATE-GATED ROLLOUT — explicitly
  // not proof of an HPA decision. Patching readinessProbe changes the pod
  // template, so every pod rolls gated; the stall (new pods unready while old
  // ones serve) demonstrates the readiness stage, distinct from phase 1.
  // The original probe value is preserved and restored exactly; a restore
  // failure is recorded loudly in evidence, never swallowed.
  emit('note', { text: 'Phase 2 (template-gated-rollout): 30s readiness delay on new pods. This gates the rollout, not an HPA decision.' });
  let slowStartup = null;
  // Preserve the original probe so restore is exact (absent stays absent).
  const probeBefore = JSON.parse(await kubectl(ns, 'get', 'deployment/app', '-o', 'json')).spec?.template?.spec?.containers?.[0]?.readinessProbe ?? null;
  const hadDelay = probeBefore?.initialDelaySeconds;
  try {
    if (hadDelay == null) {
      await kubectl(ns, 'patch', 'deployment/app', '--type=json', '-p', '[{"op":"add","path":"/spec/template/spec/containers/0/readinessProbe/initialDelaySeconds","value":30}]');
    } else {
      await kubectl(ns, 'patch', 'deployment/app', '--type=json', '-p', '[{"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/initialDelaySeconds","value":30}]');
    }
    // The template change itself rolls pods gated: count unready,
    // non-terminating pods while desired capacity is outstanding.
    const depDesired = Number(JSON.parse(await kubectl(ns, 'get', 'deployment/app', '-o', 'json')).spec?.replicas ?? 0);
    let unreadySamples = 0;
    for (let i = 0; i < 6; i++) {
      throwIfCancelled(hcancel);
      await unlessCancelled(sleep(5000), hcancel);
      const s = await sampleHpa(ns, emit, `slow-start+${(i + 1) * 5}s`, 'template-gated-rollout');
      series.push(s);
      const podsRaw = await kubectl(ns, 'get', 'pods', '-l', 'app=scaling-app', '-o', 'json');
      const unready = (JSON.parse(podsRaw).items || []).filter((p) => !p.metadata?.deletionTimestamp
        && !(p.status?.containerStatuses?.every((c) => c.ready))).length;
      if (unready > 0 && depDesired >= 2) unreadySamples += 1;
      if (unready > 0) emit('note', { text: `Slow-start (rollout-gated, not an HPA decision): ${unready} new pod(s) still unready, desired ${depDesired}, ready ${s.ready}.` });
    }
    slowStartup = { kind: 'template-gated-rollout', gapObserved: unreadySamples >= 3, desiredDuring: depDesired, unreadySamples, restored: false };
  } finally {
    // Exact restore, loudly: remove only what was added, replace back what
    // was changed. A failure here must fail the run, not vanish. After an
    // End-lesson cancellation the namespace teardown finalizes instead.
    if (hcancel && hcancel()) {
      if (slowStartup) { slowStartup.restored = false; slowStartup.restoreError = 'skipped after cancellation (namespace teardown finalizes)'; }
      emit('error', { text: 'Slow-startup restore skipped after cancellation: namespace teardown finalizes. Verify the deployment before reuse.' });
    } else try {
      if (hadDelay == null) {
        await kubectl(ns, 'patch', 'deployment/app', '--type=json', '-p', '[{"op":"remove","path":"/spec/template/spec/containers/0/readinessProbe/initialDelaySeconds"}]');
      } else {
        await kubectl(ns, 'patch', 'deployment/app', '--type=json', '-p', JSON.stringify([{ op: 'replace', path: '/spec/template/spec/containers/0/readinessProbe/initialDelaySeconds', value: hadDelay }]));
      }
      await kubectl(ns, 'rollout', 'status', 'deployment/app', '--timeout=180s');
      if (slowStartup) slowStartup.restored = true;
      emit('note', { text: 'Readiness probe restored to its original value; rollout settled.' });
    } catch (error) {
      if (slowStartup) { slowStartup.restored = false; slowStartup.restoreError = error.message; }
      emit('error', { text: `Slow-startup restore FAILED and needs manual attention: ${error.message}. Check kubectl --context kind-scaling-lab -n ${ns} get deployment/app.` });
    }
  }
  // Phase 3: stabilization — load already stopped; record the scale-down path.
  emit('note', { text: 'Phase 3 (stabilization): load stopped — recording recovery (scale-down stabilization holds ~60s).' });
  let samples = 0;
  for (let i = 0; i < 5; i++) {
    throwIfCancelled(hcancel);
    await unlessCancelled(sleep(15000), hcancel);
    series.push(await sampleHpa(ns, emit, `recover+${(i + 1) * 15}s`, 'stabilization'));
    samples += 1;
  }
  return gradeHpaReact({ baseline, series, predictDesired, slowStartup, recovery: { samples }, scaleOut: { firstBumpAt, allReadyAt, scaleOutLagSec } });
}

async function podCounts(ns) {
  const raw = await kubectl(ns, 'get', 'pods', '-l', 'app=scaling-app', '-o', 'json');
  const items = JSON.parse(raw).items || [];
  let scheduled = 0, running = 0, ready = 0, pending = 0;
  for (const p of items) {
    if (p.spec?.nodeName) scheduled += 1;
    if (p.status?.phase === 'Pending') pending += 1;
    if (p.status?.phase === 'Running') running += 1;
    if (!p.metadata?.deletionTimestamp && p.status?.containerStatuses?.every((c) => c.ready)) ready += 1;
  }
  const depRaw = await kubectl(ns, 'get', 'deployment/app', '-o', 'json');
  return { desired: JSON.parse(depRaw).spec?.replicas ?? null, scheduled, running, ready, pending, total: items.length };
}

async function schedulerReasons(ns) {
  try {
    const raw = await kubectl(ns, 'get', 'events', '--field-selector', 'reason=FailedScheduling', '-o', 'json');
    return (JSON.parse(raw).items || []).slice(-5).map((e) => ({ reason: e.reason, message: (e.message || '').slice(0, 300), pod: e.involvedObject?.name || null }));
  } catch { return []; }
}

export async function constrainPending(ns) {
  await kubectl(ns, 'patch', 'deployment/app', '-p', '{"spec":{"template":{"spec":{"nodeSelector":{"scaling.lab/nonexistent":"true"}}}}}');
  await kubectl(ns, 'scale', 'deployment/app', '--replicas=5');
}

export async function restorePending(ns) {
  await kubectl(ns, 'patch', 'deployment/app', '--type=json', '-p', '[{"op":"remove","path":"/spec/template/spec/nodeSelector"}]').catch(() => {});
  await kubectl(ns, 'scale', 'deployment/app', '--replicas=2');
  await kubectl(ns, 'rollout', 'status', 'deployment/app', '--timeout=180s');
  await waitStablePods(ns, 2, 90000);
}

async function runPendingScenario(emit, opts = {}) {
  const ns = opts.namespace || 'scaling-lab';
  const baseUrl = opts.endpoint || base;
  const cancel = opts.cancel || null;
  const before = await podCounts(ns);
  emit('note', { text: `Baseline in ${ns}: desired ${before.desired}, scheduled ${before.scheduled}, ready ${before.ready}. Disabling any autoscaler in this namespace (it would fight the manual scale), then applying a run-scoped impossible nodeSelector and scaling to 5.` });
  // An HPA would rewrite spec.replicas toward its own desired count and hide
  // the Pending demonstration, so existing scalers are removed first and
  // re-applied in the finally below. Run namespaces have no scaler (nothing
  // to restore); the shared CLI namespace gets its exact manifests back.
  const removed = await removeScalers(ns);
  let constrained = null, events = [];
  try {
    await constrainPending(ns);
    // Let the constraint roll: old pods are pinned by maxUnavailable 0 while
    // replacements cannot schedule, so Pending appears alongside survivors.
    const until = Date.now() + 60000;
    do {
      throwIfCancelled(cancel);
      await unlessCancelled(sleep(5000), cancel);
      constrained = await podCounts(ns);
    } while (Date.now() < until && !(constrained.desired === 5 && constrained.pending >= 2));
    events = await schedulerReasons(ns);
    emit('note', { text: `Constrained: desired ${constrained.desired}, scheduled ${constrained.scheduled}, running ${constrained.running}, ready ${constrained.ready}, pending ${constrained.pending}. ${events[0]?.message?.slice(0, 160) || 'No scheduler reason yet.'}` });
    const probe = await capacityRequest('/fast', baseUrl, 3000, new http.Agent({ keepAlive: false }));
    emit('note', { text: `Probe while constrained: ${probe.ok ? 'served by surviving pre-constraint pods (maxUnavailable 0 pins old pods until replacements are Ready — replacements never become Ready)' : `not served (${probe.error || `HTTP ${probe.status}`}) — Pending pods serve nothing`}.` });
  } finally {
    emit('note', { text: 'Restoring schedulability (removing the constraint, back to 2 replicas).' });
    if (cancel && cancel()) {
      emit('error', { text: 'Restore skipped after cancellation: namespace teardown finalizes. Verify the deployment before reuse.' });
    } else {
      await restorePending(ns).catch((e) => emit('error', { text: `Restore needs attention: ${e.message}` }));
      await restoreScalers(ns, removed, emit);
    }
  }
  const restored = await podCounts(ns);
  emit('note', { text: `Restored: desired ${restored.desired}, ready ${restored.ready}, pending ${restored.pending}. kind never autoscales nodes — the GKE continuation covers node scale-up.` });
  return gradePending({ constrained: constrained || before, restored, events });
}

async function runPrometheusScenario(emit, opts = {}) {
  const ns = opts.namespace || 'scaling-lab';
  const baseUrl = opts.endpoint || base;
  const rateQuery = opts.rateQuery || REQUEST_RATE_QUERY;
  const upQuery = opts.upQuery || SCRAPE_UP_QUERY;
  await kubectl(ns, 'get', 'scaledobject', 'app-prometheus', '-o', 'name').catch(() => { throw new Error('Prometheus scaler is missing. Run make prometheus-up first.'); });
  await waitStablePods(ns);
  const forward = await startPrometheusForward();
  try {
    let scrapeTargets = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      scrapeTargets = await prometheusValue(forward.port, upQuery) ?? 0;
      if (scrapeTargets >= 2) break;
      await sleep(5000);
    }
    if (scrapeTargets < 2) throw new Error('Prometheus is not scraping both app pods yet. Check the prometheus targets page.');
    const initialState = await clusterState(ns);
    requireAutoscaler(initialState, 'prometheus');
    const initial = initialState.pods.filter(x => !x.terminating).length;
    let peak = initial;
    let peakRps = 0;
    let monitoring = false;
    const sample = async () => {
      if (monitoring) return;
      monitoring = true;
      try {
        const [rps, state] = await Promise.all([prometheusValue(forward.port, rateQuery), clusterState(ns)]);
        peakRps = Math.max(peakRps, rps ?? 0);
        peak = Math.max(peak, state.pods.filter(x => !x.terminating).length);
        emit('prometheus', { rps, pods: state.pods.length, desired: state.hpa?.desired, text: `${rps == null ? 'warming up' : rps.toFixed(1) + ' req/s'} · ${state.pods.length} pods · desired ${state.hpa?.desired ?? '?'}` });
      } catch (error) { emit('note', { text: `Metric sample unavailable: ${error.message}` }); }
      finally { monitoring = false; }
    };
    emit('note', { text: `Prometheus is scraping ${scrapeTargets} app pods. Sending request load.` });
    const timer = setInterval(sample, 5000);
    const load = await traffic(80000, '/fast', emit, 30, 15, baseUrl, opts.cancel || null);
    clearInterval(timer);
    await sample();
    emit('note', { text: `Load stopped. Peak observed rate ${peakRps.toFixed(1)} req/s; watching scale down.` });
    let stableDown = false;
    let final = peak;
    const drain = [];
    const until = Date.now() + 180000;
    while (Date.now() < until && !stableDown) {
      throwIfCancelled(opts.cancel || null);
      drain.push(...await traffic(5000, '/fast', emit, 500, 5, baseUrl, opts.cancel || null));
      await sample();
      const state = await clusterState(ns);
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
      evidence: { query: rateQuery, thresholdRpsPerPod: 5, scrapeTargets, initial, peak, final, peakRps, loadRequests: load.length, loadFailures: load.filter(x => !x.ok).length, drainRequests: drain.length, drainFailures: drain.filter(x => !x.ok).slice(0, 10) }
    };
  } finally { forward.close(); }
}

export async function runScenario(id, options, emit) {
  const ns = options.namespace || 'scaling-lab';
  const baseUrl = options.endpoint || base;
  emit('note', { text: `Starting ${id}` });
  if (id === 'connections') {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const reused = [];
    const fresh = [];
    for (let i = 0; i < 8; i++) {
      const r = await startRequest('/fast', agent, baseUrl).done;
      reused.push(r.edgeConnection);
      emit('request', { group: 'keep-alive', ...r, body: undefined });
    }
    agent.destroy();
    for (let i = 0; i < 8; i++) {
      const r = await startRequest('/fast', false, baseUrl).done;
      fresh.push(r.edgeConnection);
      emit('request', { group: 'new connection', ...r, body: undefined });
    }
    return gradeConnections(reused, fresh);
  }
  if (id === 'timeouts') {
    async function pair(gapMs) {
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      const first = await startRequest('/fast', agent, baseUrl).done;
      emit('request', { group: `${gapMs}ms idle`, ...first, body: undefined });
      await sleep(gapMs);
      const second = await startRequest('/fast', agent, baseUrl).done;
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
    await kubectl(ns, 'set', 'env', 'deployment/app', `SHUTDOWN_MODE=${mode}`);
    await kubectl(ns, 'rollout', 'status', 'deployment/app', '--timeout=180s');
    await waitStablePods(ns);
    const slowReq = startRequest('/slow?ms=8000', new http.Agent({ keepAlive: true }), baseUrl);
    const slowHeaders = await slowReq.headers;
    if (!slowHeaders.pod) throw new Error(`Long request did not reach a pod: ${slowHeaders.error}`);
    emit('slow-start', slowHeaders);
    const stopLogWatch = watchPodLogs(slowHeaders.pod, emit, ns);
    const background = traffic(11000, '/fast', emit, 120, 1, baseUrl, options.cancel || null);
    await sleep(900);
    emit('pod-delete', { pod: slowHeaders.pod });
    await kubectl(ns, 'delete', 'pod', slowHeaders.pod, '--wait=false');
    const slow = { ...await slowReq.done, pod: slowHeaders.pod };
    emit('slow-end', slow);
    const samples = await background;
    stopLogWatch();
    return gradeShutdown({ slow, samples, deletedPod: slowHeaders.pod, mode });
  }
  if (id === 'rollout') {
    await kubectl(ns, 'set', 'env', 'deployment/app', 'SHUTDOWN_MODE=graceful');
    await kubectl(ns, 'rollout', 'status', 'deployment/app', '--timeout=180s');
    await waitStablePods(ns);
    const before = await podNames(ns);
    const background = traffic(15000, '/fast', emit, 120, 1, baseUrl, options.cancel || null);
    await sleep(1000);
    emit('rollout', { text: 'Starting rolling update' });
    await kubectl(ns, 'set', 'env', 'deployment/app', `LAB_REV=${Date.now()}`);
    await kubectl(ns, 'rollout', 'status', 'deployment/app', '--timeout=180s');
    const samples = await background;
    const after = await podNames(ns);
    return gradeRollout(samples, before, after);
  }
  if (id === 'streaming') {
    await kubectl(ns, 'set', 'env', 'deployment/app', 'SHUTDOWN_MODE=graceful');
    await kubectl(ns, 'rollout', 'status', 'deployment/app', '--timeout=180s');
    await waitStablePods(ns);
    const streamRequest = startRequest('/stream', new http.Agent({ keepAlive: true }), baseUrl);
    const streamHeaders = await streamRequest.headers;
    if (!streamHeaders.pod) throw new Error(`Stream did not reach a pod: ${streamHeaders.error}`);
    emit('stream-start', streamHeaders);
    const stopLogWatch = watchPodLogs(streamHeaders.pod, emit, ns);
    await sleep(1100);
    emit('pod-delete', { pod: streamHeaders.pod });
    await kubectl(ns, 'delete', 'pod', streamHeaders.pod, '--wait=false');
    const stream = { ...await streamRequest.done, pod: streamHeaders.pod };
    emit('stream-end', { pod: stream.pod, requestId: stream.requestId || streamHeaders.requestId, status: stream.status, complete: stream.complete, error: stream.error });
    stopLogWatch();
    return gradeStream({ stream, deletedPod: streamHeaders.pod });
  }
  if (id === 'autoscale') {
    const state = await clusterState(ns);
    requireAutoscaler(state, 'cpu');
    const initial = state.pods.filter(x => !x.terminating).length;
    emit('note', { text: `Starting CPU load with ${initial} pods` });
    const samples = await traffic(75000, '/cpu?ms=120', emit, 150, 1, baseUrl, options.cancel || null);
    const scaled = await clusterState(ns);
    const peak = scaled.pods.filter(x => !x.terminating).length;
    emit('note', { text: `CPU load stopped at ${peak} pods; watching scale down` });
    let final = peak;
    let stableDown = false;
    const drainSamples = [];
    const until = Date.now() + 180000;
    while (Date.now() < until && !stableDown) {
      throwIfCancelled(options.cancel || null);
      drainSamples.push(...await traffic(5000, '/fast', emit, 250, 1, baseUrl, options.cancel || null));
      const current = await clusterState(ns);
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
  if (id === 'prometheus') return runPrometheusScenario(emit, options);
  if (id === 'capacity') return runCapacityScenario(emit, options);
  if (id === 'hpareact') return runHpaReactScenario(emit, options);
  if (id === 'pending') return runPendingScenario(emit, options);
  if (id === 'resources') return runResourcesScenario(emit, options);
  if (id === 'signals') return runSignalsScenario(emit, options);
  if (id === 'downstream') return runDownstreamScenario(emit, options);
  if (id === 'disruptions') return runDisruptionsScenario(emit, options);
  if (id === 'gateway') return runGatewayScenario(emit, options);
  if (id === 'capstone') return runCapstoneScenario(emit, options);
  throw new Error('Unknown scenario');
}

function kubectlApply(ns, obj) {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', ['--context', 'kind-scaling-lab', ...(ns ? ['-n', ns] : []), 'apply', '-f', '-'], { timeout: 60000 });
    let err = '';
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`kubectl apply failed: ${err.trim().slice(0, 300)}`))));
    child.stdin.write(JSON.stringify(obj));
    child.stdin.end();
  });
}

function kubectlRaw(ns, path, body) {
  return new Promise((resolve) => {
    const child = spawn('kubectl', ['--context', 'kind-scaling-lab', '-n', ns, 'create', '--raw', path, '-f', '-'], { timeout: 30000 });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', (e) => resolve({ code: 1, out: '', err: String(e?.message || e) }));
    child.on('close', (code) => resolve({ code: code ?? 1, out: out.trim(), err: err.trim() }));
    child.stdin.write(JSON.stringify(body));
    child.stdin.end();
  });
}

async function evictPod(ns, pod) {
  const r = await kubectlRaw(ns, `/api/v1/namespaces/${ns}/pods/${pod}/eviction`, { apiVersion: 'policy/v1', kind: 'Eviction', metadata: { name: pod, namespace: ns } });
  const text = `${r.out} ${r.err}`.trim();
  const blocked = r.code !== 0 && /429|TooManyRequests|Forbidden|disruption budget/i.test(text);
  return { pod, allowed: r.code === 0, status: r.code, detail: text.slice(0, 300) || `exit ${r.code}` };
}

export async function topFor(ns, label) {
  try {
    const raw = await kubectl(ns, 'top', 'pods', '-l', label, '--no-headers');
    const cpus = [];
    for (const line of raw.split('\n')) {
      const parts = line.trim().split(/\s+/);
      const m = parts.length >= 2 ? /^([0-9]+)m?$/.exec(parts[1]) : null;
      if (m) cpus.push(parts[1].endsWith('m') ? Number(m[1]) : Number(m[1]) * 1000);
    }
    if (!cpus.length) return null;
    return { pods: cpus.length, avgCpuM: Math.round(cpus.reduce((a, b) => a + b, 0) / cpus.length) };
  } catch { return null; }
}

export async function depInflightGauge(ns) {
  try {
    const out = await kubectl(ns, 'exec', 'deployment/dep', '--', 'node', '-e', `fetch('http://127.0.0.1:3000/metrics').then((r)=>r.text()).then((t)=>{const m=t.match(/scaling_lab_http_inflight_requests\\{pod=("[^"]*")\\} ([0-9.]+)/);console.log(m?m[2]:'none')})`);
    const v = Number(out.trim().split('\n').pop());
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

async function containerResources(ns) {
  const raw = await kubectl(ns, 'get', 'deployment/app', '-o', 'json');
  return JSON.parse(raw).spec?.template?.spec?.containers?.[0]?.resources || null;
}

async function patchContainerResources(ns, resources, cancel = null, expected = null) {
  throwIfCancelled(cancel);
  await kubectl(ns, 'patch', 'deployment/app', '-p', JSON.stringify({ spec: { template: { spec: { containers: [{ name: 'app', resources }] } } } }));
  await unlessCancelled(kubectl(ns, 'rollout', 'status', 'deployment/app', '--timeout=180s'), cancel);
  // expected==null skips the count wait: under a live HPA the replica count
  // legitimately moves, so only the rollout gate applies.
  if (expected != null) await waitStablePods(ns, expected, 90000, cancel);
}

async function restartInfo(ns) {
  const raw = await kubectl(ns, 'get', 'pods', '-l', 'app=scaling-app', '-o', 'json');
  let restarts = 0;
  const reasons = [];
  for (const p of JSON.parse(raw).items || []) {
    for (const c of p.status?.containerStatuses || []) {
      restarts += c.restartCount || 0;
      const reason = c.lastState?.terminated?.reason;
      if (reason) reasons.push(`${p.metadata.name}:${reason}`);
    }
  }
  return { restarts, reasons };
}

async function avgUtil(ns, samples, cancel = null) {
  // Median, not mean: rollout transients spike single samples, and the
  // median survives them while the mean does not.
  const vals = [];
  for (let i = 0; i < samples; i++) {
    throwIfCancelled(cancel);
    await unlessCancelled(sleep(5000), cancel);
    const s = await hpaSnapshot(ns).catch(() => null);
    if (s?.currentCPU != null) vals.push(s.currentCPU);
  }
  if (vals.length < 2) return null;
  vals.sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : Math.round((vals[mid - 1] + vals[mid]) / 2);
}

// cpu.stat snapshot keyed by pod name, so deltas always compare the same
// pod instance: the hottest same-name pod carries the signal, and a pod
// that vanished mid-window voids its delta instead of comparing strangers.
async function cpuStatAll(ns) {
  const raw = await kubectl(ns, 'get', 'pods', '-l', 'app=scaling-app', '-o', 'json');
  const names = (JSON.parse(raw).items || [])
    .filter((p) => !p.metadata?.deletionTimestamp && p.status?.phase === 'Running')
    .map((p) => p.metadata.name);
  const map = {};
  for (const name of names) {
    const stat = await cpuThrottle(ns, name);
    if (stat) map[name] = stat;
  }
  return map;
}

function hottestDelta(before, after) {
  let best = null;
  for (const name of Object.keys(before)) {
    const a = before[name], b = after[name];
    if (!b || a.usageUsec == null || b.usageUsec == null) continue;
    const usage = b.usageUsec - a.usageUsec;
    const throttled = (b.throttledUsec ?? 0) - (a.throttledUsec ?? 0);
    if (usage < 0 || throttled < 0) continue; // counter reset: pod recycled mid-window
    if (!best || usage > best.usageMs * 1000) best = { name, usageMs: Math.round(usage / 1000), throttledUsec: throttled };
  }
  return best;
}

const RES_DEFAULTS = { requests: { cpu: '100m', memory: '64Mi' }, limits: { cpu: '1', memory: '128Mi' } };

const RES_CPU_HPA = {
  apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler',
  metadata: { name: 'app' },
  spec: {
    scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'app' },
    minReplicas: 2, maxReplicas: 5,
    behavior: { scaleDown: { stabilizationWindowSeconds: 60 } },
    metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 60 } } }],
  },
};

async function runResourcesScenario(emit, opts = {}) {
  const ns = opts.namespace || 'scaling-lab';
  const baseUrl = opts.endpoint || base;
  const cancel = opts.cancel || null;
  await hpaSnapshot(ns).catch(() => { throw new Error('The CPU HPA is not active in this namespace. Create a fresh resources run (it provisions its own HPA).'); });
  // Preserve the exact original resources: every phase restores from these,
  // and the finally below restores them even on error or cancellation.
  // (Request must never exceed limit — Kubernetes rejects such pairs.)
  const original = await containerResources(ns);
  emit('note', { text: `Baseline resources: ${JSON.stringify(original)}. Phase 1 keeps the HPA and holds CPU traffic constant while the CPU request quadruples (limit stays 1, so 400m ≤ 1 is valid).` });
  let denom = null, throttle = null, oom = null, restored = false, hpaRestored = false;
  const bg = [];
  // Stop scope merges End-lesson cancellation with internal-error teardown:
  // any failure below first stops owned background work and awaits its actual
  // settlement before the finally restores.
  const scope = createStopScope(cancel);
  const cancelFn = scope.cancelFn;
  try {
    // Phase 1: denominator effect at constant traffic. The load stays alive
    // through BOTH sampling windows and is explicitly stopped and drained
    // afterwards: a fixed window cannot cover rollout plus API time, so a
    // hardcoded trafficSame would credit samples taken after traffic waned.
    // Coverage is generation-based (offer timestamps + generator stop time),
    // never completion-based: delayed completions after generation stopped,
    // or a failures-only window, cannot prove unchanged useful work. Both
    // windows need generation spanning them at rate with dominated successes
    // or the phase is inconclusive. HPA replica moves and the ~30s metrics
    // lag are recorded in evidence, not assumed away (utilization is the
    // per-pod average, so the ratio still reads the denominator rather than
    // total work).
    const gen = { offers: [], stoppedAt: null, successes: [], failures: [] };
    let activeWindow = null;
    const phase1Emit = (type, data) => {
      if (activeWindow) {
        const now = Date.now();
        if (type === 'sample') gen.successes.push(now);
        else if (type === 'request') gen.failures.push(now);
      }
      emit(type, data);
    };
    const phase1Stop = createStopScope(cancelFn);
    const probe = {
      offered: (t) => gen.offers.push(t),
      stopped: (t) => { if (gen.stoppedAt == null) gen.stoppedAt = t; },
    };
    // 300s is a backstop, not the plan: the explicit stop below ends
    // generation right after the second window. A natural end before that
    // (very slow rollout) fails the span check and yields inconclusive, never
    // a pass on partial coverage.
    const loadP = traffic(300000, '/cpu?ms=120', phase1Emit, 200, 5, baseUrl, phase1Stop.cancelFn, probe).then(
      () => {},
      (error) => { if (error?.code === CANCELLED) return; throw error; },
    );
    bg.push(loadP.catch(() => {}));
    await unlessCancelled(sleep(40000), cancelFn);
    const winBeforeStart = Date.now();
    activeWindow = 'before';
    const utilBefore = await avgUtil(ns, 3, cancelFn);
    activeWindow = null;
    const winBeforeEnd = Date.now();
    const desiredBefore = (await hpaSnapshot(ns).catch(() => ({}))).desired ?? null;
    await patchContainerResources(ns, { requests: { cpu: '400m', memory: original?.requests?.memory || '64Mi' }, limits: { cpu: '1', memory: original?.limits?.memory || '128Mi' } }, cancelFn, null);
    emit('note', { text: `CPU request ${original?.requests?.cpu || '?'}→400m (same traffic). Utilization was ${utilBefore}%; settling 30s past the rollout, then resampling.` });
    await unlessCancelled(sleep(30000), cancelFn);
    const winAfterStart = Date.now();
    activeWindow = 'after';
    const utilAfter = await avgUtil(ns, 5, cancelFn);
    activeWindow = null;
    const winAfterEnd = Date.now();
    const desiredAfter = (await hpaSnapshot(ns).catch(() => ({}))).desired ?? null;
    // Explicit stop ends GENERATION here; the join below then drains delayed
    // completions. Coverage is judged on offers, so drain events can never
    // retroactively cover a window.
    phase1Stop.requestStop();
    await loadP;
    throwIfCancelled(cancelFn);
    const shared = { offers: gen.offers, successes: gen.successes, failures: gen.failures, generatorStoppedAt: gen.stoppedAt, intervalMs: 200 };
    const before = evaluateWindowCoverage({ ...shared, winStart: winBeforeStart, winEnd: winBeforeEnd });
    const after = evaluateWindowCoverage({ ...shared, winStart: winAfterStart, winEnd: winAfterEnd });
    const covered = before.ok && after.ok;
    denom = {
      utilBefore, utilAfter, desiredBefore, desiredAfter, trafficSame: covered,
      windows: {
        before: { ...before.detail, reasons: before.reasons },
        after: { ...after.detail, reasons: after.reasons },
      },
    };
    emit('note', { text: covered
      ? `Denominator: ${utilBefore}%→${utilAfter}% with generation spanning both windows at ~5 RPS (desired ${desiredBefore}→${desiredAfter}; before: ${before.detail.offered} offered/${before.detail.successes} succeeded, after: ${after.detail.offered} offered/${after.detail.successes} succeeded).`
      : `Denominator sampling LACKED constant-load generation (${[...before.reasons, ...after.reasons].join('; ')}) — phase inconclusive, never graded as shown.` });
    // Phases 2–3 need FIXED capacity: the HPA would spread load across new
    // pods and hide both throttling and OOM. It is removed here (metrics
    // still flow; only the scaler object goes) and re-applied in the
    // finally, with its absence stated in evidence.
    await kubectl(ns, 'delete', 'hpa', '--all', '--ignore-not-found');
    await kubectl(ns, 'scale', 'deployment/app', '--replicas=2');
    await waitStablePods(ns, 2, 90000, cancelFn);
    emit('note', { text: 'HPA removed and callers pinned to exactly 2 pods for deterministic throttle/OOM measurement (re-applied at the end).' });
    // Phase 2: throttling measured directly via cpu.stat. Valid pair:
    // request 100m ≤ limit 150m. Measured on the hottest pod (pinned by edge
    // keepalive), UID-pinned across the window: a pod change mid-window
    // voids the delta honestly instead of comparing strangers.
    const stats0 = await cpuStatAll(ns);
    const loadA = await pacedRequests(baseUrl, '/cpu?ms=120', 5, 25000, 8000, emit, { cancel: cancelFn });
    const stats1 = await cpuStatAll(ns);
    const hotA = hottestDelta(stats0, stats1);
    const baseDelta = hotA?.throttledUsec ?? null;
    const baseUsage = hotA?.usageMs ?? null;
    await patchContainerResources(ns, { requests: { cpu: '100m', memory: original?.requests?.memory || '64Mi' }, limits: { cpu: '150m', memory: original?.limits?.memory || '128Mi' } }, cancelFn, 2);
    const stats2 = await cpuStatAll(ns);
    const loadB = await pacedRequests(baseUrl, '/cpu?ms=120', 5, 30000, 8000, emit, { cancel: cancelFn });
    const stats3 = await cpuStatAll(ns);
    const hotB = hottestDelta(stats2, stats3);
    const top = await topFor(ns, 'app=scaling-app');
    const tightDelta = hotB?.throttledUsec ?? null;
    const tightUsage = hotB?.usageMs ?? null;
    const loadSummary = (p) => ({ offered: p.offered, completed: p.completed, failed: p.failed, timeouts: p.timeouts, dropped: p.dropped });
    throttle = { baseDeltaUsec: baseDelta, tightDeltaUsec: tightDelta, baseUsageMs: baseUsage, tightUsageMs: tightUsage, cappedCpuM: top?.avgCpuM ?? null, capped: top != null && top.avgCpuM < 250, fixedReplicas: 2, loadBase: loadSummary(loadA), loadTight: loadSummary(loadB), podBase: hotA?.name || null, podTight: hotB?.name || null, samePod: Boolean(hotA && hotB) };
    emit('note', { text: `Throttling (cpu.stat, hottest same-name pod each window): +${baseDelta}µs over ${baseUsage}ms burned at limit 1 vs +${tightDelta}µs over ${tightUsage}ms at limit 150m; pod CPU capped ~${top?.avgCpuM ?? '?'}m.` });
    // Phase 3: bounded OOM with restart + termination-reason evidence.
    // Exactly 2 pods × up to 4 concurrent 32MB allocs each (128MB > 96Mi).
    await patchContainerResources(ns, { requests: { cpu: '100m', memory: original?.requests?.memory || '64Mi' }, limits: { cpu: '150m', memory: '96Mi' } }, cancelFn, 2);
    const r0 = await restartInfo(ns);
    const agent = new http.Agent({ keepAlive: false });
    let allocOk = 0, allocFailed = 0;
    try {
      throwIfCancelled(cancelFn);
      const results = await Promise.all(Array.from({ length: 8 }, () => capacityRequest('/alloc?mb=32&holdMs=1500', baseUrl, 8000, agent)));
      allocOk = results.filter((r) => r.ok).length;
      allocFailed = results.length - allocOk;
    } finally {
      agent.destroy();
    }
    emit('note', { text: `Memory burst: ${allocOk} served, ${allocFailed} failed during the burst; waiting for termination state.` });
    await unlessCancelled(sleep(8000), cancelFn);
    const r1 = await restartInfo(ns);
    oom = { restartsBefore: r0.restarts, restartsAfter: r1.restarts, reason: r1.reasons.find((x) => /OOMKilled/.test(x)) || r1.reasons[0] || null, reasons: r1.reasons.slice(0, 4), allocOk, allocFailed, fixedReplicas: 2 };
    emit('note', { text: `OOM demo: restarts ${r0.restarts}→${r1.restarts}, termination ${oom.reason || 'none recorded'}.` });
  } catch (error) {
    // Ownership handoff: rethrows the original error when the owned drain
    // finishes, or the distinct cleanup failure (cause-attached) when it does
    // not — a cancelled scenario never hides an unsettled drain.
    await settleOwnedWork(scope, bg, emit, 'resources background load', error);
  } finally {
    try {
      if (typeof cancel === 'function' && cancel()) throw Object.assign(new Error('restore skipped after cancellation: namespace teardown finalizes'), { code: CANCELLED });
      await patchContainerResources(ns, {
        requests: { cpu: original?.requests?.cpu || '100m', memory: original?.requests?.memory || '64Mi' },
        limits: { cpu: original?.limits?.cpu || '1', memory: original?.limits?.memory || '128Mi' },
      }, null, 2);
      const back = await containerResources(ns);
      restored = back?.requests?.cpu === (original?.requests?.cpu || '100m')
        && back?.limits?.cpu === (original?.limits?.cpu || '1')
        && back?.limits?.memory === (original?.limits?.memory || '128Mi');
      emit('note', { text: `Resources restored to originals: ${JSON.stringify(back)}.` });
      await kubectlApply(ns, { ...RES_CPU_HPA, metadata: { ...RES_CPU_HPA.metadata, namespace: ns } });
      await kubectl(ns, 'get', 'hpa', 'app', '-o', 'name');
      hpaRestored = true;
      emit('note', { text: 'CPU HPA re-applied after deterministic phases.' });
    } catch (error) {
      if (error?.code === CANCELLED) emit('note', { text: 'Restore skipped after cancellation: namespace teardown finalizes. Verify the deployment before reuse.' });
      else emit('error', { text: `Restore FAILED: ${error.message}. Check kubectl --context kind-scaling-lab -n ${ns} get deployment/app,hpa.` });
    }
  }
  return gradeResources({ denom, throttle, oom, restored: restored && hpaRestored });
}

// Owned background work (load loops) runs under a stop scope: the scope merges
// End-lesson cancellation with an internal stop request, so any error path can
// halt exactly the work it owns. drainBg then awaits ACTUAL settlement — never
// a blind race that returns while requests are still arriving — with a
// generous bound; a false return means cleanup did not finish, and the caller
// must report failure rather than grade or archive as if it drained. The
// timeout timer is cleared on every path.
export function createStopScope(externalCancel = null) {
  const local = { requested: false };
  return {
    cancelFn: () => (typeof externalCancel === 'function' && externalCancel()) || local.requested,
    requestStop: () => { local.requested = true; },
  };
}

// Generation-based window coverage (resources phase 1): completion events
// alone cannot prove constant load — delayed completions and timeouts emitted
// after generation stopped would still land inside a later window. A window
// counts only when the generator itself offered across it at the intended
// rate through its end, AND successful (useful) work dominates the window.
// Anything else yields ok:false with reasons, and the grader stays
// inconclusive. Pure function over recorded timestamps: unit-testable.
export function evaluateWindowCoverage({ offers, successes, failures, generatorStoppedAt, winStart, winEnd, intervalMs, minSuccesses = 5 }) {
  const inWindow = (times) => (times || []).filter((t) => t >= winStart && t <= winEnd);
  const offered = inWindow(offers);
  const expected = Math.max(1, Math.round((winEnd - winStart) / intervalMs));
  const firstOffer = offered.length ? offered[0] : null;
  const lastOffer = offered.length ? offered[offered.length - 1] : null;
  const okSuccess = inWindow(successes);
  const failCount = inWindow(failures).length;
  const reasons = [];
  if (!(generatorStoppedAt != null && generatorStoppedAt >= winEnd)) reasons.push(`generation ended before the window end (stoppedAt ${generatorStoppedAt}, winEnd ${winEnd})`);
  if (!(offered.length >= expected / 2)) reasons.push(`offer shortfall: ${offered.length} offered vs ~${expected} expected at ${intervalMs}ms intervals`);
  if (!(lastOffer != null && winEnd - lastOffer <= Math.max(1500, intervalMs * 3))) reasons.push('no offer near the window end: generation did not span the window');
  if (!(okSuccess.length >= minSuccesses)) reasons.push(`only ${okSuccess.length} successful completions in window (need ${minSuccesses})`);
  if (!(okSuccess.length >= failCount)) reasons.push(`failures dominate (${failCount} failed vs ${okSuccess.length} succeeded): not unchanged useful work`);
  return {
    ok: reasons.length === 0,
    reasons,
    detail: { winStart, winEnd, offered: offered.length, expected, successes: okSuccess.length, failures: failCount, generatorStoppedAt, firstOffer, lastOffer },
  };
}

export async function drainBg(bg, emit = null, timeoutMs = 120000) {
  if (!bg.length) return true;
  let timer = null;
  try {
    return await Promise.race([
      Promise.allSettled(bg).then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs)); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Distinct cleanup failure: background work owned by a scenario did not
// settle after stop was requested. The server must retain the allocation on
// this code — never archive, delete, or reuse the environment — until the
// SAME registered work is awaited to settlement.
export const CLEANUP_UNSETTLED = 'CLEANUP_UNSETTLED';

// Outstanding-work ownership: key -> { label, at, promises }. Entries are
// removed only by awaitUnsettled after every promise actually settles, so a
// retry always rejoins the SAME work instead of starting over.
const unsettled = new Map();
export function registerUnsettled(label, promises, key = null) {
  const id = key || `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  unsettled.set(id, { label, at: new Date().toISOString(), promises: [...promises] });
  return id;
}
export function hasUnsettled(key) { return unsettled.has(key); }
export async function awaitUnsettled(key, timeoutMs = 120000) {
  const entry = unsettled.get(key);
  if (!entry) return true;
  let timer = null;
  try {
    const settled = await Promise.race([
      Promise.allSettled(entry.promises).then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs)); }),
    ]);
    if (settled) unsettled.delete(key);
    return settled;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export function cleanupUnsettledError(label, bg, cause) {
  const key = registerUnsettled(label, bg);
  const error = new Error(`${label}: background work did not settle after stop was requested; environment retained for retry.`);
  error.code = CLEANUP_UNSETTLED;
  error.cleanupKey = key;
  if (cause) error.cause = cause;
  return error;
}
// Shared error-path ownership handoff: stop owned work, await its actual
// settlement, and rethrow the ORIGINAL error when the drain finishes. When it
// does not finish, throw the distinct cleanup failure (carrying the original
// as cause) instead — a cancelled scenario never hides an unsettled drain.
// Always throws; callers write `catch (e) { await settleOwnedWork(...); }`.
export async function settleOwnedWork(scope, bg, emit, label, originalError, drainTimeoutMs = 120000) {
  scope.requestStop();
  const drained = await drainBg(bg, emit, drainTimeoutMs);
  if (drained) throw originalError;
  emit('error', { text: `${label}: background work did not settle after stop was requested; restoration still runs, but this run cannot be graded — environment retained for retry.` });
  throw cleanupUnsettledError(label, bg, originalError);
}

async function runSignalsScenario(emit, opts = {}) {
  const ns = opts.namespace || 'scaling-lab';
  const baseUrl = opts.endpoint || base;
  const cancel = opts.cancel || null;
  const rps = 6;
  emit('note', { text: `Comparing CPU burn vs slow I/O at equal offered RPS (${rps}/s, 20s each). CPU is sampled DURING each phase; missing samples stay missing, never zero.` });
  async function phase(path) {
    const tops = [];
    const sampler = (async () => {
      for (let i = 0; i < 4; i++) {
        await unlessCancelled(sleep(5000), cancel);
        tops.push(await topFor(ns, 'app=scaling-app'));
      }
    })();
    try {
      // Instant per-pod cgroup usage brackets the whole phase: the hottest
      // same-name pod's burned CPU separates the workloads even though edge
      // keepalive pins all of a phase's load onto one pod.
      const usage0 = await cpuStatAll(ns);
      const p = await pacedRequests(baseUrl, path, rps, 20000, 8000, emit, { cancel });
      const usage1 = await cpuStatAll(ns);
      await unlessCancelled(sampler, cancel);
      const hot = hottestDelta(usage0, usage1);
      const valid = tops.filter((t) => t != null);
      return { ...summarizePaced(p, 1e9), avgCpuM: valid.length ? Math.round(valid.reduce((a, t) => a + t.avgCpuM, 0) / valid.length) : null, cpuSamples: valid.length, hotPod: hot?.name || null, hotUsageMs: hot?.usageMs ?? null };
    } finally {
      await sampler.catch(() => {});
    }
  }
  const cpuPhase = await phase('/cpu?ms=200');
  const ioPhase = await phase('/slow?ms=800');
  emit('note', { text: `CPU work: hottest pod burned ${cpuPhase.hotUsageMs ?? 'unread'}ms over the phase (top avg ~${cpuPhase.avgCpuM ?? 'unread'}m, ${cpuPhase.cpuSamples}/4 samples), p50 ${cpuPhase.p50}ms. Slow I/O: hottest pod burned ${ioPhase.hotUsageMs ?? 'unread'}ms (top avg ~${ioPhase.avgCpuM ?? 'unread'}m), p50 ${ioPhase.p50}ms — same RPS, different cost.` });
  return gradeSignals({ cpuPhase, ioPhase, rps });
}

// Laptop-bounded downstream experiment shape (Milestone 4): every load phase
// offers the same workload for the same duration; settling gaps between
// phases are bounded and residual in-flight work is captured, never assumed
// away. The Dashboard-provisioned dep workload is required; there is no CLI
// substitute (see make verify docs).
export const DOWNSTREAM_RPS = 12;
export const DOWNSTREAM_PHASE_MS = 30000;
export const DOWNSTREAM_SETTLE_MS = 12000;
export const DOWNSTREAM_REQUEST_TIMEOUT_MS = 6000;
export const DOWNSTREAM_SLO_MS = 2000;
export const DOWNSTREAM_MIN_OFFERED = 200;
export const DOWNSTREAM_PATH = '/dep?ms=300&via=cpu';
export const DOWNSTREAM_POLICY_AGGRESSIVE = { retries: 3, timeoutMs: 2500, backoffMs: 50 };
export const DOWNSTREAM_POLICY_STRICT = { retries: 0, timeoutMs: 1000, backoffMs: 100 };
export const DOWNSTREAM_POLICY_DEFAULT = { retries: 0, timeoutMs: 1500, backoffMs: 100 };

export function depPolicyLabel({ retries, timeoutMs, backoffMs }) {
  return `retries=${retries},timeout=${timeoutMs}ms,backoff=${backoffMs}ms`;
}

// Bounded attempts sample: reads at most 20 small JSON bodies with
// concurrency 4 to measure the real retry-attempt distribution per policy.
export async function sampleDepAttempts(baseUrl, path, n = 20) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  const attempts = [];
  try {
    const queue = Array.from({ length: n }, () => path);
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const p = queue.shift();
        try {
          const r = await fetch(`${baseUrl}${p}`, { signal: AbortSignal.timeout(10000) });
          const body = await r.json().catch(() => ({}));
          if (Number.isFinite(body.attempts)) attempts.push(body.attempts);
        } catch { /* counted as missing, not invented */ }
      }
    }));
  } finally {
    agent.destroy();
  }
  attempts.sort((a, b) => a - b);
  return { n: attempts.length, avg: attempts.length ? Math.round((attempts.reduce((a, b) => a + b, 0) / attempts.length) * 100) / 100 : null, max: attempts.length ? attempts[attempts.length - 1] : null };
}

export async function setDepPolicy(ns, { retries, timeoutMs, backoffMs }, cancel, expected = null) {
  throwIfCancelled(cancel);
  await kubectl(ns, 'set', 'env', 'deployment/app', `DEP_RETRIES=${retries}`, `DEP_TIMEOUT_MS=${timeoutMs}`, `DEP_BACKOFF_MS=${backoffMs}`);
  await unlessCancelled(kubectl(ns, 'rollout', 'status', 'deployment/app', '--timeout=180s'), cancel);
  if (expected != null) await waitStablePods(ns, expected, 90000, cancel);
}

// Bounded settling between downstream phases (Q4.3): stop offering load for
// a fixed window so queues drain, then read the residual dependency
// in-flight gauge. The gauge may legitimately read null (metrics endpoint
// unreadable); the attempt itself is recorded so the grader can tell
// "captured none" apart from "never looked".
export async function settleDownstream(ns, emit, label, ms = DOWNSTREAM_SETTLE_MS, cancel = null) {
  const startedAt = new Date().toISOString();
  throwIfCancelled(cancel);
  emit('note', { text: `${label}: settling ${Math.round(ms / 1000)}s — no offered load while queues drain.` });
  await unlessCancelled(sleep(ms), cancel);
  const residualInflight = await depInflightGauge(ns);
  emit('note', { text: `${label}: residual dep in-flight ${residualInflight ?? 'unread'} after settling.` });
  return { label, startedAt, finishedAt: new Date().toISOString(), waitMs: ms, residualInflight };
}

export async function depReplicaCount(ns) {
  try {
    const raw = await kubectl(ns, 'get', 'deployment/dep', '-o', 'json');
    return JSON.parse(raw).spec?.replicas ?? null;
  } catch { return null; }
}

export async function runDownstreamScenario(emit, opts = {}) {
  const ns = opts.namespace || 'scaling-lab';
  const baseUrl = opts.endpoint || base;
  const cancel = opts.cancel || null;
  const rps = DOWNSTREAM_RPS;
  const phaseMs = Number(opts.phaseMs ?? DOWNSTREAM_PHASE_MS);
  const settleMs = Number(opts.settleMs ?? DOWNSTREAM_SETTLE_MS);
  await kubectl(ns, 'get', 'deployment/dep', '-o', 'name').catch(() => { throw new Error('The isolated dependency is missing. Create a fresh downstream run (it provisions its own dep).'); });
  const probeAgent = new http.Agent({ keepAlive: false });
  let probe;
  try {
    probe = await capacityRequest('/dep?ms=100&via=cpu', baseUrl, 4000, probeAgent);
  } finally {
    probeAgent.destroy();
  }
  if (!probe.ok) throw new Error(`Dependency probe failed (${probe.error || probe.status}). Check deployment/dep in ${ns}.`);
  const depReplicas = await depReplicaCount(ns);
  let phaseS = null, phaseA = null, phaseB = null;
  let depS = null, depA = null, depB = null;
  let settling = [];
  let restored = false;
  let restoreError = null;
  async function measurePhase({ label, callers, policy }) {
    const depCpuBefore = await topFor(ns, 'app=scaling-dep');
    const depSamples = [];
    let measuring = true;
    const observation = (async () => {
      while (measuring) {
        const cpu = await topFor(ns, 'app=scaling-dep');
        depSamples.push({ at: new Date().toISOString(), cpuM: cpu?.avgCpuM ?? null });
        if (measuring) await sleep(2000);
      }
    })();
    let raw;
    try {
      raw = await pacedRequests(baseUrl, DOWNSTREAM_PATH, rps, phaseMs, DOWNSTREAM_REQUEST_TIMEOUT_MS, emit, { countShed: true, cancel });
    } finally { measuring = false; await observation; }
    const attempts = await sampleDepAttempts(baseUrl, DOWNSTREAM_PATH);
    const measuredCpu = depSamples.map((s) => s.cpuM).filter(Number.isFinite);
    const dep = { cpuM: measuredCpu.length ? Math.max(...measuredCpu) : null, samples: depSamples, inflight: await depInflightGauge(ns), cpuBeforeM: depCpuBefore?.avgCpuM ?? null, depReplicas };
    const callersReady = await readyPods(ns);
    const phase = {
      ...summarizePaced(raw, DOWNSTREAM_SLO_MS),
      workload: { path: DOWNSTREAM_PATH, rps, durationMs: phaseMs },
      settings: { callersDesired: callers, callersReady, policy: { ...policy }, depReplicas },
      depCpuM: dep.cpuM,
      attemptsAvg: attempts.avg, attemptsMax: attempts.max, attemptsN: attempts.n,
      policyLabel: depPolicyLabel(policy),
    };
    emit('note', { text: `${label}: ${callers} callers (ready ${callersReady}), ${depPolicyLabel(policy)} — timely ${phase.timelyRps}/s, shed ${phase.shed}, timeouts ${phase.timeouts}, p95 ${phase.p95}ms, attempts avg ${attempts.avg} (max ${attempts.max}, n=${attempts.n}); dep CPU ~${dep.cpuM}m (was ~${dep.cpuBeforeM}m), dep inflight gauge ${dep.inflight ?? 'unread'}.` });
    return { phase, dep };
  }
  try {
    // Q4.1 — two-caller measured baseline with the aggressive budget, so the
    // later four-caller phase compares measurement against measurement under
    // the same dependency, offered workload, resources, and retry policy.
    emit('note', { text: `Phase S (scale baseline, Q4.1): 2 callers, ${depPolicyLabel(DOWNSTREAM_POLICY_AGGRESSIVE)} — ${rps} RPS at a ${depReplicas ?? 1}-pod CPU-bound dependency.` });
    await kubectl(ns, 'scale', 'deployment/app', '--replicas=2');
    await waitStablePods(ns, 2, 90000, cancel);
    await setDepPolicy(ns, DOWNSTREAM_POLICY_AGGRESSIVE, cancel, 2);
    ({ phase: phaseS, dep: depS } = await measurePhase({ label: 'Phase S', callers: 2, policy: DOWNSTREAM_POLICY_AGGRESSIVE }));
    settling.push(await settleDownstream(ns, emit, 'Settle S→A', settleMs, cancel));
    // Q4.1 — same budget and workload at four callers: only the caller count
    // moves. Actual Ready counts plus dep-side saturation decide the verdict.
    emit('note', { text: `Phase A (scale-out, Q4.1): 4 callers, same ${depPolicyLabel(DOWNSTREAM_POLICY_AGGRESSIVE)} and workload — only the caller count moves.` });
    await kubectl(ns, 'scale', 'deployment/app', '--replicas=4');
    await waitStablePods(ns, 4, 90000, cancel);
    await setDepPolicy(ns, DOWNSTREAM_POLICY_AGGRESSIVE, cancel, 4);
    ({ phase: phaseA, dep: depA } = await measurePhase({ label: 'Phase A', callers: 4, policy: DOWNSTREAM_POLICY_AGGRESSIVE }));
    settling.push(await settleDownstream(ns, emit, 'Settle A→B', settleMs, cancel));
    // Q4.2 — same callers and workload, tighter budget. Timeout moves together
    // with retries, so the verdict names the COMBINED budget change and never
    // attributes it to retries alone.
    emit('note', { text: `Phase B (strict budget, Q4.2): same 4 callers and load, combined budget change to ${depPolicyLabel(DOWNSTREAM_POLICY_STRICT)} — shed early instead of amplifying.` });
    await setDepPolicy(ns, DOWNSTREAM_POLICY_STRICT, cancel, 4);
    ({ phase: phaseB, dep: depB } = await measurePhase({ label: 'Phase B', callers: 4, policy: DOWNSTREAM_POLICY_STRICT }));
  } catch (error) {
    if (error?.code === CANCELLED) throw error;
    emit('error', { text: `Downstream measurement FAILED: ${error.message}. Partial phases are kept; restore still runs.` });
    throw error;
  } finally {
    try {
      throwIfCancelled(cancel);
      await kubectl(ns, 'scale', 'deployment/app', '--replicas=2');
      await kubectl(ns, 'set', 'env', 'deployment/app', `DEP_RETRIES=${DOWNSTREAM_POLICY_DEFAULT.retries}`, `DEP_TIMEOUT_MS=${DOWNSTREAM_POLICY_DEFAULT.timeoutMs}`, `DEP_BACKOFF_MS=${DOWNSTREAM_POLICY_DEFAULT.backoffMs}`);
      await kubectl(ns, 'rollout', 'status', 'deployment/app', '--timeout=180s');
      await waitStablePods(ns, 2, 90000);
      restored = true;
      emit('note', { text: 'Callers restored to 2 replicas with the default dependency policy.' });
    } catch (error) {
      restoreError = error.message;
      if (error?.code !== CANCELLED) emit('error', { text: `Downstream restore FAILED: ${error.message}. Check kubectl --context kind-scaling-lab -n ${ns} get deployment/app.` });
      else emit('error', { text: 'Downstream restore skipped after cancellation: namespace teardown finalizes. Verify the deployment before reuse.' });
    }
  }
  return gradeDownstream({ phaseS, phaseA, phaseB, depS, depA, depB, settling, restored, restoreError });
}

const DISRUPTION_PDB = (ns) => ({
  apiVersion: 'policy/v1', kind: 'PodDisruptionBudget',
  metadata: { name: 'app-pdb', namespace: ns },
  spec: { maxUnavailable: 1, selector: { matchLabels: { app: 'scaling-app' } } },
});

async function pdbStatus(ns) {
  try {
    const raw = await kubectl(ns, 'get', 'pdb', 'app-pdb', '-o', 'json');
    const p = JSON.parse(raw);
    return {
      disruptionsAllowed: p.status?.disruptionsAllowed ?? null,
      currentHealthy: p.status?.currentHealthy ?? null,
      desiredHealthy: p.status?.desiredHealthy ?? null,
      expectedPods: p.status?.expectedPods ?? null,
    };
  } catch { return null; }
}

async function runDisruptionsScenario(emit, opts = {}) {
  const ns = opts.namespace || 'scaling-lab';
  const baseUrl = opts.endpoint || base;
  const cancel = opts.cancel || null;
  let e1 = null, e2 = null, deleted = null, trafficRes = null, pdbRemoved = false;
  const bg = [];
  // The 90s background load is owned work: the scope lets any error below
  // stop it, and the catch awaits its actual settlement before PDB cleanup,
  // so no request outlives the environment becoming reusable.
  const scope = createStopScope(cancel);
  const cancelFn = scope.cancelFn;
  try {
    await kubectlApply(ns, DISRUPTION_PDB(ns));
    emit('note', { text: 'PDB applied (maxUnavailable 1 over 3 pods). Background traffic started; evictions honor the budget, deletes do not.' });
    const trafficP = traffic(90000, '/fast', emit, 120, 5, baseUrl, cancelFn);
    bg.push(trafficP.catch(() => {}));
    await unlessCancelled(sleep(3000), cancelFn);
    const pods = await podNames(ns);
    throwIfCancelled(cancel);
    e1 = await evictPod(ns, pods[0]);
    emit('note', { text: `Evict ${pods[0]}: ${e1.allowed ? 'ALLOWED' : `refused (${e1.detail.slice(0, 120)})`}.` });
    // Deterministic block condition: poll the PDB itself until it reports
    // zero allowed disruptions (the first victim must actually count as
    // unavailable) BEFORE attempting the second eviction. A fixed sleep
    // races pod termination and proves nothing.
    let budgetWaitSecs = 0;
    {
      const until = Date.now() + 90000;
      let allowedNow = null;
      while (Date.now() < until) {
        throwIfCancelled(cancel);
        const st = await pdbStatus(ns);
        allowedNow = st?.disruptionsAllowed ?? null;
        if (allowedNow === 0) break;
        budgetWaitSecs = Math.round((Date.now() - (until - 90000)) / 1000);
        await unlessCancelled(sleep(3000), cancel);
      }
      emit('note', { text: `PDB disruptionsAllowed=${allowedNow ?? 'unread'} after ${budgetWaitSecs}s of waiting for the first victim to count as unavailable.` });
    }
    const remainingRaw = await kubectl(ns, 'get', 'pods', '-l', 'app=scaling-app', '-o', 'json');
    const remaining = (JSON.parse(remainingRaw).items || [])
      .filter((p) => !p.metadata?.deletionTimestamp && p.status?.containerStatuses?.every((c) => c.ready))
      .map((p) => p.metadata.name)
      .filter((p) => p !== pods[0]);
    if (!remaining.length) throw new Error('No Ready surviving pod to attempt the second eviction on.');
    e2 = await evictPod(ns, remaining[0]);
    const pdb = await pdbStatus(ns);
    e2.pdbAllowed = pdb?.disruptionsAllowed ?? null;
    e2.pdb = pdb;
    emit('note', { text: `Evict ${remaining[0] || pods[1]}: ${e2.allowed ? 'ALLOWED (budget had room — see PDB status)' : `BLOCKED (${e2.detail.slice(0, 120)})`}; PDB disruptionsAllowed=${pdb?.disruptionsAllowed ?? 'unread'}.` });
    await unlessCancelled(sleep(3000), cancel);
    const victim = (await podNames(ns))[0];
    throwIfCancelled(cancel);
    await kubectl(ns, 'delete', 'pod', victim, '--wait=false');
    deleted = { pod: victim, deleted: true };
    emit('note', { text: `Direct delete of ${victim}: succeeded (PDBs do not stop deletes). Rolling under traffic.` });
    await kubectl(ns, 'set', 'env', 'deployment/app', `LAB_REV=${Date.now()}`);
    await unlessCancelled(kubectl(ns, 'rollout', 'status', 'deployment/app', '--timeout=180s'), cancel);
    const samples = await unlessCancelled(trafficP, cancel);
    const failures = samples.filter((x) => !x.ok);
    trafficRes = { total: samples.length, failures: failures.length, kinds: [...new Set(failures.map((x) => x.error || `HTTP ${x.status}`))].slice(0, 5) };
    emit('note', { text: `Background: ${samples.length} sampled, ${failures.length} failed (${trafficRes.kinds.join(', ') || 'none'}).` });
  } catch (error) {
    // Ownership handoff: rethrows the original error when the owned drain
    // finishes, or the distinct cleanup failure (cause-attached) when it does
    // not — a cancelled scenario never hides an unsettled drain.
    await settleOwnedWork(scope, bg, emit, 'disruptions background traffic', error);
  } finally {
    try {
      await kubectl(ns, 'delete', 'pdb', 'app-pdb', '--ignore-not-found');
      pdbRemoved = (await pdbStatus(ns)) === null;
      if (!pdbRemoved) emit('error', { text: 'PDB cleanup FAILED: app-pdb still present.' });
    } catch (error) {
      emit('error', { text: `PDB cleanup FAILED: ${error.message}.` });
    }
  }
  return gradeDisruptions({ evict1: e1, evict2: e2, deleted, traffic: trafficRes, pdbRemoved });
}

async function endpointReadyGoneAt(ns, pod, timeoutMs = 15000, cancel = null) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    throwIfCancelled(cancel);
    try {
      const raw = await kubectl(ns, 'get', 'endpointslices', '-l', 'kubernetes.io/service-name=app', '-o', 'json');
      const present = (JSON.parse(raw).items || []).flatMap((x) => x.endpoints || [])
        .some((e) => e.targetRef?.name === pod && e.conditions?.ready && !e.conditions?.terminating);
      if (!present) return new Date().toISOString();
    } catch { /* keep polling */ }
    await sleep(500);
  }
  return null;
}

async function runGatewayScenario(emit, opts = {}) {
  const ns = opts.namespace || 'scaling-lab';
  const baseUrl = opts.endpoint || base;
  const cancel = opts.cancel || null;
  const agent = new http.Agent({ keepAlive: true });
  try {
    const slowReq = startRequest('/slow?ms=8000', agent, baseUrl);
    const headers = await slowReq.headers;
    if (!headers.pod) throw new Error(`Drain request did not reach a pod: ${headers.error}`);
    emit('slow-start', headers);
    const bgP = traffic(25000, '/fast', emit, 150, 5, baseUrl, cancel);
    await unlessCancelled(sleep(900), cancel);
    const podDeleteAt = new Date().toISOString();
    emit('pod-delete', { pod: headers.pod });
    await kubectl(ns, 'delete', 'pod', headers.pod, '--wait=false');
    // Request completion and endpoint observation run INDEPENDENTLY: the end
    // timestamp is stamped the moment the request promise settles, never
    // after awaiting the endpoint poll, so neither order can be fabricated.
    let requestEndAt = null, slow = null;
    const doneP = slowReq.done.then((r) => {
      slow = { ...r, pod: headers.pod };
      requestEndAt = new Date().toISOString();
      emit('slow-end', slow);
      return r;
    });
    const goneP = endpointReadyGoneAt(ns, headers.pod, 15000, cancel);
    await doneP;
    const endpointGoneAt = await goneP;
    const samples = await bgP;
  const bg = { ok: 0, http502: 0, transport: 0 };
  for (const s of samples) {
    if (s.ok) bg.ok += 1;
    else if ([502, 503, 504].includes(s.status)) bg.http502 += 1;
    else bg.transport += 1;
  }
  const ordering = endpointGoneAt && requestEndAt
    ? (Date.parse(endpointGoneAt) <= Date.parse(requestEndAt)
      ? `endpoint removal preceded response completion by ${Math.round((Date.parse(requestEndAt) - Date.parse(endpointGoneAt)) / 100) / 10}s`
      : `response completion preceded endpoint removal by ${Math.round((Date.parse(endpointGoneAt) - Date.parse(requestEndAt)) / 100) / 10}s`)
    : null;
  emit('note', { text: `Drain: slow request ${slow.complete ? `completed in ${slow.ms}ms` : `interrupted (${slow.error || 'no body'})`}; ${ordering || 'endpoint timing unrecorded'}. Background: ${bg.ok} ok, ${bg.http502} HTTP 502/503/504, ${bg.transport} transport failures.` });
  return gradeGateway({ drain: { podDeleteAt, endpointGoneAt, requestEndAt, ordering, slowOutcome: { complete: slow.complete, ms: slow.ms, status: slow.status, error: slow.error || null }, bg } });
  } catch (error) {
    try { await bgP; } catch { /* settled for evidence; original error wins */ }
    throw error;
  } finally {
    agent.destroy();
  }
}

const CAPSTONE_MIX = {
  balanced: { path: '/fast', rps: 15 },
  'cpu-heavy': { path: '/cpu?ms=120', rps: 8 },
  'io-heavy': { path: '/slow?ms=600', rps: 8 },
};

async function probePhase(baseUrl, path, durationMs, timeoutMs, opts = {}) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });
  const lat = [];
  let failed = 0;
  const until = Date.now() + durationMs;
  try {
    while (Date.now() < until) {
      throwIfCancelled(opts.cancel);
      const r = await capacityRequest(path, baseUrl, timeoutMs, agent);
      if (r.complete && r.ok) lat.push(r.ms);
      else failed += 1;
      await sleep(2000);
    }
  } finally {
    agent.destroy();
  }
  lat.sort((a, b) => a - b);
  const samples = lat.length + failed;
  return { p95: percentile(lat, 95), errorPct: samples ? Math.round((failed / samples) * 1000) / 10 : 100, samples };
}

async function runCapstoneScenario(emit, opts = {}) {
  const ns = opts.namespace || 'scaling-lab';
  const baseUrl = opts.endpoint || base;
  const cancel = opts.cancel || null;
  const { sloP95Ms, sloErrorPct, mix, minReplicas, maxReplicas, cpuTarget, rationale } = validateCapstoneOptions(opts.options);
  const spec = CAPSTONE_MIX[mix];
  const objective = { sloP95Ms, sloErrorPct, mix, path: spec.path, rps: spec.rps, minReplicas, maxReplicas, cpuTarget, rationale };
  emit('note', { text: `Capstone objective: p95 ≤ ${sloP95Ms}ms, errors ≤ ${sloErrorPct}% on ${mix} traffic (${spec.rps} RPS ${spec.path}). HPA min ${minReplicas}, max ${maxReplicas}, CPU target ${cpuTarget}%. Rationale: ${rationale.slice(0, 120)}. Graded traffic runs THROUGHOUT each event — post-event probes alone never pass. Replica growth alone never passes.` });
  // Apply the learner-configured HPA bounds to the provisioned scaler before
  // any graded phase. Laptop bounds are enforced by validateCapstoneOptions.
  await kubectlApply(ns, {
    apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler',
    metadata: { name: 'app', namespace: ns },
    spec: {
      scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'app' },
      minReplicas, maxReplicas,
      behavior: { scaleDown: { stabilizationWindowSeconds: 60 } },
      metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: cpuTarget } } }],
    },
  });
  emit('note', { text: `Capstone HPA applied: minReplicas ${minReplicas}, maxReplicas ${maxReplicas}, CPU target ${cpuTarget}%.` });
  // Every phase grades the actual paced stream concurrent with its event.
  // Partial evidence is emitted as notes throughout, so cancellation or
  // failure still leaves an honest trail in the archived events.
  const toPhase = (stream) => {
    const total = stream.completed + stream.failed;
    return {
      p95: percentile(stream.lat, 95),
      errorPct: total ? Math.round((stream.failed / total) * 1000) / 10 : 100,
      samples: total, offered: stream.offered, dropped: stream.dropped,
      timeouts: stream.timeouts, statusCounts: stream.statusCounts,
    };
  };
  const phases = {};
  const bg = [];
  // Rollout/disruption streams are owned background work: the scope stops
  // them on any error and the catch awaits their actual settlement before
  // PDB cleanup, so no graded traffic outlives its phase.
  const scope = createStopScope(cancel);
  const cancelFn = scope.cancelFn;
  try {
    // Burst.
    emit('note', { text: 'Phase burst: 40s elevated load, graded throughout.' });
    const burst = await pacedRequests(baseUrl, spec.path, spec.rps, 40000, 5000, emit, { cancel });
    phases.burst = toPhase(burst);
    emit('note', { text: `Burst: offered ${burst.offered}, p95 ${phases.burst.p95}ms, errors ${phases.burst.errorPct}% (${phases.burst.samples} samples).` });
    // Rollout under traffic: the stream covers trigger, roll, and settle.
    emit('note', { text: 'Phase rollout: traffic runs through trigger, roll, and settle.' });
    const rollP = pacedRequests(baseUrl, spec.path, spec.rps, 45000, 5000, emit, { cancel: cancelFn });
    bg.push(rollP.catch(() => {}));
    await unlessCancelled(sleep(3000), cancel);
    throwIfCancelled(cancel);
    await kubectl(ns, 'set', 'env', 'deployment/app', `LAB_REV=${Date.now()}`);
    await unlessCancelled(kubectl(ns, 'rollout', 'status', 'deployment/app', '--timeout=180s'), cancel);
    const roll = await unlessCancelled(rollP, cancel);
    phases.rollout = toPhase(roll);
    emit('note', { text: `Rollout: offered ${roll.offered}, p95 ${phases.rollout.p95}ms, errors ${phases.rollout.errorPct}% (${phases.rollout.samples} samples).` });
    // Guarded disruption: PDB-honoring eviction under traffic. An actual
    // allowed eviction is required — a refused one fails the phase openly.
    emit('note', { text: 'Phase disruption: PDB-guarded eviction under traffic (allowed eviction required).' });
    await kubectlApply(ns, DISRUPTION_PDB(ns));
    const disP = pacedRequests(baseUrl, spec.path, spec.rps, 30000, 5000, emit, { cancel: cancelFn });
    bg.push(disP.catch(() => {}));
    await unlessCancelled(sleep(3000), cancel);
    const dpods = await podNames(ns);
    throwIfCancelled(cancel);
    const ev = await evictPod(ns, dpods[0]);
    emit('note', { text: `Eviction of ${dpods[0]}: ${ev.allowed ? 'allowed' : `REFUSED (${ev.detail.slice(0, 100)}) — phase cannot pass without an allowed disruption`}.` });
    const dis = await unlessCancelled(disP, cancel);
    phases.disruption = { ...toPhase(dis), eviction: ev.allowed ? 'allowed' : 'refused' };
    emit('note', { text: `Disruption: offered ${dis.offered}, p95 ${phases.disruption.p95}ms, errors ${phases.disruption.errorPct}% (${phases.disruption.samples} samples), eviction ${phases.disruption.eviction}.` });
    // Recovery: settling traffic, still graded.
    emit('note', { text: 'Phase recovery: 30s settling traffic, still graded.' });
    const rec = await pacedRequests(baseUrl, spec.path, Math.max(3, Math.floor(spec.rps / 3)), 30000, 5000, emit, { cancel });
    phases.recovery = toPhase(rec);
    emit('note', { text: `Recovery: p95 ${phases.recovery.p95}ms, errors ${phases.recovery.errorPct}% (${phases.recovery.samples} samples).` });
  } catch (error) {
    // Ownership handoff: rethrows the original error when the owned drain
    // finishes, or the distinct cleanup failure (cause-attached) when it does
    // not — a cancelled scenario never hides an unsettled drain.
    await settleOwnedWork(scope, bg, emit, 'capstone background traffic', error);
  } finally {
    try {
      await kubectl(ns, 'delete', 'pdb', 'app-pdb', '--ignore-not-found');
    } catch (error) {
      emit('error', { text: `PDB cleanup FAILED: ${error.message}.` });
    }
  }
  return gradeCapstone({ objective, phases });
}
