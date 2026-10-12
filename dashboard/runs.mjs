import { spawn, execFile } from 'node:child_process';
import { clientOutcomes } from './client-outcomes.mjs';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHistory, pushMilestone } from './timeline.mjs';
import { queryPrometheus, upQueryForRun } from './prometheus.mjs';

const runFile = promisify(execFile);
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function realExec(args) {
  return runFile('kubectl', args, { timeout: 180000 });
}

function realApply(ns, obj) {
  const base = ['--context', 'kind-scaling-lab', ...(ns ? ['-n', ns] : [])];
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', [...base, 'apply', '-f', '-'], { timeout: 60000 });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`kubectl apply failed: ${stderr.trim()}`))));
    child.stdin.write(JSON.stringify(obj));
    child.stdin.end();
  });
}

// Injectable dependencies so lifecycle tests run without touching a cluster.
// exec(args) -> {stdout}; apply(ns, obj); forward(ns) -> {port, close};
// query(promql) -> {value, at, stale}; sleep(ms); genId() -> run id.
export const realDeps = {
  exec: realExec,
  apply: realApply,
  forward: null, // set below (needs kubectlBase-free port-forward)
  query: (q) => queryPrometheus(q),
  sleep: realSleep,
  genId: createRunId,
};

export const MAX_ACTIVE_RUNS = 7;
// Every lesson can run isolated. Autoscaling lessons add a scaler; capacity
// runs a single pod with no scaler; the rest get app + edge only.
export const RUN_LESSONS = new Set(['connections', 'timeouts', 'shutdown', 'rollout', 'streaming', 'autoscale', 'prometheus',
  'capacity', 'resources', 'hpareact', 'signals', 'downstream', 'pending', 'disruptions', 'gateway', 'capstone']);
// Per-lesson run shape: replica count and optional scaler. Bounded laptop
// footprint: at most 3 app pods + 1 edge pod per run (disruptions uses 3 so a
// PDB can block while one pod stays serving).
export const RUN_CONFIG = {
  connections: { replicas: 2, scaler: null },
  timeouts: { replicas: 2, scaler: null },
  shutdown: { replicas: 2, scaler: null },
  rollout: { replicas: 2, scaler: null },
  streaming: { replicas: 2, scaler: null },
  autoscale: { replicas: 2, scaler: 'cpu-hpa' },
  prometheus: { replicas: 2, scaler: 'keda' },
  capacity: { replicas: 1, scaler: null },
  resources: { replicas: 2, scaler: 'cpu-hpa' },
  hpareact: { replicas: 2, scaler: 'cpu-hpa' },
  signals: { replicas: 2, scaler: null },
  downstream: { replicas: 2, scaler: null },
  pending: { replicas: 2, scaler: null },
  disruptions: { replicas: 3, scaler: null },
  gateway: { replicas: 2, scaler: null },
  capstone: { replicas: 2, scaler: 'cpu-hpa' },
};
export function runConfig(lesson) {
  const cfg = RUN_CONFIG[lesson];
  if (!cfg) throw new Error(`Unknown run lesson: ${lesson}.`);
  return cfg;
}
const RUN_ID_RE = /^[a-z0-9]{8}$/;

export function createRunId() {
  return randomBytes(4).toString('hex');
}

export function validateRunId(id) {
  if (typeof id !== 'string' || !RUN_ID_RE.test(id)) {
    throw new Error(`Invalid run id ${JSON.stringify(id)}. Expected 8 lowercase hex chars issued by POST /api/runs.`);
  }
  return id;
}

export function namespaceFor(runId) {
  return `scaling-run-${validateRunId(runId)}`;
}

// Lesson prerequisites against shared infrastructure (single-lesson Start
// reports these as understandable stages; missing items produce actionable
// setup guidance, never silent provisioning or cluster mutation).
const PREREQ_GUIDANCE = {
  cluster: 'The kind-scaling-lab cluster is unreachable. Recreate the lab (make up), then Start again — Start never recreates a cluster by itself.',
  metrics: 'The metrics server is missing. Run: make hpa-up — then Start again.',
  prometheus: 'Prometheus is missing. Run: make prometheus-up — then Start again.',
  keda: 'KEDA is missing. Run: make prometheus-up — then Start again.',
};
const LESSON_PREREQS = {
  autoscale: ['cluster', 'metrics'],
  hpareact: ['cluster', 'metrics'],
  resources: ['cluster', 'metrics'],
  capstone: ['cluster', 'metrics'],
  prometheus: ['cluster', 'prometheus', 'keda'],
  signals: ['cluster', 'prometheus'],
};

export async function checkLessonPrereqs(lesson, deps = realDeps) {
  const wants = LESSON_PREREQS[lesson] || ['cluster'];
  const checks = [];
  const need = async (name, args) => {
    try {
      await deps.exec(['--context', 'kind-scaling-lab', ...args]);
      checks.push({ name, ok: true });
    } catch {
      checks.push({ name, ok: false, guidance: PREREQ_GUIDANCE[name] });
    }
  };
  if (wants.includes('cluster')) await need('cluster', ['get', 'nodes', '--no-headers']);
  if (wants.includes('metrics')) await need('metrics', ['-n', 'kube-system', 'get', 'deployment', 'metrics-server', '-o', 'name']);
  if (wants.includes('prometheus')) await need('prometheus', ['-n', 'scaling-lab', 'get', 'deployment', 'prometheus', '-o', 'name']);
  if (wants.includes('keda')) await need('keda', ['-n', 'keda', 'get', 'deployment', 'keda-operator', '-o', 'name']);
  const missing = checks.filter((c) => !c.ok);
  return { ok: missing.length === 0, checks, missing };
}

export const runs = new Map();
export const archives = new Map();

// Re-adopt run namespaces left behind by a dashboard restart. Strictly scoped:
// the name must match scaling-run-<8 hex>, the owner label must be exactly
// "dashboard", and the lesson must be one the dashboard can drive. Anything
// else is never touched. Adopted runs resume sampling under a new edge
// forward; their previous in-memory events are gone (archive files persist).
export async function adoptOrphanRuns(deps = realDeps) {
  const adopted = [];
  let items = [];
  try {
    const raw = await deps.exec(kubectlBase(null).concat(['get', 'namespaces', '-l', 'scaling.lab/owner=dashboard', '-o', 'json']));
    items = JSON.parse(raw.stdout).items;
  } catch {
    return adopted;
  }
  for (const ns of items) {
    const name = ns.metadata?.name || '';
    const labels = ns.metadata?.labels || {};
    const m = /^scaling-run-([a-z0-9]{8})$/.exec(name);
    if (!m) continue;
    if (labels['scaling.lab/owner'] !== 'dashboard') continue;
    if (!RUN_LESSONS.has(labels['scaling.lab/lesson'])) continue;
    const id = m[1];
    if (runs.has(id)) continue;
    const present = await deps.exec(kubectlBase(name).concat(['get', 'deployment/app', 'deployment/edge', '-o', 'name'])).then(() => true).catch(() => false);
    const run = {
      id, ns: name, lesson: labels['scaling.lab/lesson'], status: present ? 'ready' : 'degraded',
      error: present ? null : 'Run namespace is missing its app or edge deployment.',
      createdAt: ns.metadata.creationTimestamp || new Date().toISOString(),
      steps: [], events: [], timeline: createHistory(), result: null,
      load: null, forward: null, forwardPort: null, prev: null, readopted: true,
    };
    if (present) {
      try {
        const fwd = await deps.forward(id);
        run.forward = fwd; run.forwardPort = fwd.port;
      } catch (error) {
        run.status = 'degraded';
        run.error = error.message;
      }
    }
    runs.set(id, run);
    adopted.push(run);
  }
  return adopted;
}

function kubectlBase(ns) {
  return ['--context', 'kind-scaling-lab', ...(ns ? ['-n', ns] : [])];
}

async function kubectl(d, ...args) {
  const { stdout } = await d.exec(kubectlBase(null).concat(args));
  return stdout.trim();
}

function startEdgeForwardReal(runId) {
  const ns = namespaceFor(runId);
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', [...kubectlBase(ns), 'port-forward', '--address', '127.0.0.1', 'service/edge', ':8080'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Edge port-forward did not start for run ${runId}`)); }, 15000);
    let output = '';
    const inspect = (chunk) => {
      output += chunk.toString();
      const m = output.match(/Forwarding from 127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ port: Number(m[1]), close: () => child.kill() }); }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.on('error', (e) => { clearTimeout(timeout); reject(e); });
    child.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`Edge port-forward exited ${code} for run ${runId}: ${output}`)); });
  });
}

realDeps.forward = startEdgeForwardReal;

const APP_IMAGE = 'scaling-lab-app:local';

function appEnvFor(lesson, ns) {
  const base = [
    { name: 'SHUTDOWN_MODE', value: 'graceful' },
    { name: 'SHUTDOWN_MS', value: '24000' },
  ];
  // Lesson 12 calls an isolated in-namespace dependency with a bounded pool.
  if (lesson === 'downstream') {
    base.push({ name: 'UPSTREAM_URL', value: `http://dep.${ns}.svc.cluster.local:3000` });
    base.push({ name: 'DEP_POOL', value: '2' });
    base.push({ name: 'DEP_TIMEOUT_MS', value: '1500' });
    base.push({ name: 'DEP_RETRIES', value: '0' });
    base.push({ name: 'DEP_BACKOFF_MS', value: '100' });
  }
  return base;
}

function depManifests(ns) {
  return [
    {
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'dep', namespace: ns },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'scaling-dep' } },
        template: {
          metadata: { labels: { app: 'scaling-dep' } },
          spec: {
            terminationGracePeriodSeconds: 15,
            containers: [{
              name: 'dep', image: APP_IMAGE, imagePullPolicy: 'Never',
              ports: [{ containerPort: 3000 }],
              env: [{ name: 'SHUTDOWN_MODE', value: 'graceful' }, { name: 'SHUTDOWN_MS', value: '10000' }],
              resources: { requests: { cpu: '100m', memory: '64Mi' }, limits: { cpu: '1', memory: '128Mi' } },
              readinessProbe: { httpGet: { path: '/health/ready', port: 3000 }, periodSeconds: 1 },
            }],
          },
        },
      },
    },
    {
      apiVersion: 'v1', kind: 'Service',
      metadata: { name: 'dep', namespace: ns },
      spec: { selector: { app: 'scaling-dep' }, ports: [{ name: 'http', port: 3000, targetPort: 3000 }] },
    },
  ];
}

function appManifests(runId, ns, lesson = 'connections') {
  const { replicas } = runConfig(lesson);
  const podLabels = { app: 'scaling-app', labrun: runId };
  return [
    {
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'app', namespace: ns, labels: { ...podLabels, 'scaling.lab/run': runId } },
      spec: {
        replicas,
        strategy: { rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
        selector: { matchLabels: podLabels },
        template: {
          metadata: { labels: podLabels },
          spec: {
            terminationGracePeriodSeconds: 30,
            containers: [{
              name: 'app', image: APP_IMAGE, imagePullPolicy: 'Never',
              ports: [{ containerPort: 3000 }],
              env: appEnvFor(lesson, ns),
              resources: { requests: { cpu: '100m', memory: '64Mi' }, limits: { cpu: '1', memory: '128Mi' } },
              lifecycle: { preStop: { exec: { command: ['node', '/app/prestop.mjs'] } } },
              startupProbe: { httpGet: { path: '/health/live', port: 3000 }, periodSeconds: 1, failureThreshold: 20 },
              readinessProbe: { httpGet: { path: '/health/ready', port: 3000 }, periodSeconds: 1 },
              livenessProbe: { httpGet: { path: '/health/live', port: 3000 }, periodSeconds: 5 },
            }],
          },
        },
      },
    },
    {
      apiVersion: 'v1', kind: 'Service',
      metadata: { name: 'app', namespace: ns },
      spec: { selector: podLabels, ports: [{ name: 'http', port: 3000, targetPort: 3000 }] },
    },
  ];
}

const EDGE_CONF = `upstream app_backend {
  server app.SVC_PLACEHOLDER:3000;
  keepalive 32;
}
server {
  listen 8080;
  location / {
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header X-Request-Id $request_id;
    proxy_pass http://app_backend;
    proxy_buffering off;
    proxy_read_timeout 35s;
    add_header X-Edge-Connection $connection always;
  }
}
`;

function edgeManifests(ns) {
  return [
    {
      apiVersion: 'v1', kind: 'ConfigMap',
      metadata: { name: 'edge-config', namespace: ns },
      data: { 'default.conf': EDGE_CONF.replace('app.SVC_PLACEHOLDER', `app.${ns}.svc.cluster.local`) },
    },
    {
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'edge', namespace: ns },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'scaling-edge' } },
        template: {
          metadata: { labels: { app: 'scaling-edge' } },
          spec: {
            containers: [{
              name: 'nginx', image: 'nginx:1.27-alpine',
              ports: [{ containerPort: 8080 }],
              volumeMounts: [{ name: 'config', mountPath: '/etc/nginx/conf.d/default.conf', subPath: 'default.conf' }],
              readinessProbe: { tcpSocket: { port: 8080 }, periodSeconds: 2 },
            }],
            volumes: [{ name: 'config', configMap: { name: 'edge-config' } }],
          },
        },
      },
    },
    {
      apiVersion: 'v1', kind: 'Service',
      metadata: { name: 'edge', namespace: ns },
      spec: { selector: { app: 'scaling-edge' }, ports: [{ name: 'http', port: 8080, targetPort: 8080 }] },
    },
  ];
}

function cpuHpaManifest(ns) {
  return {
    apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler',
    metadata: { name: 'app', namespace: ns },
    spec: {
      scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'app' },
      minReplicas: 2, maxReplicas: 5,
      behavior: { scaleDown: { stabilizationWindowSeconds: 60 } },
      metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 60 } } }],
    },
  };
}

function scaledObjectManifest(runId, ns) {
  return {
    apiVersion: 'keda.sh/v1alpha1', kind: 'ScaledObject',
    metadata: { name: 'app-prometheus', namespace: ns },
    spec: {
      scaleTargetRef: { name: 'app' },
      minReplicaCount: 2, maxReplicaCount: 5, pollingInterval: 5,
      advanced: { horizontalPodAutoscalerConfig: { behavior: { scaleDown: { stabilizationWindowSeconds: 60 } } } },
      triggers: [{
        type: 'prometheus',
        metadata: {
          serverAddress: 'http://prometheus.scaling-lab.svc.cluster.local:9090',
          query: `sum(rate(scaling_lab_http_requests_total{job="scaling-app",labrun="${runId}"}[30s]))`,
          threshold: '5', activationThreshold: '1', ignoreNullValues: 'false',
        },
      }],
    },
  };
}

function namespaceManifest(runId, lesson) {
  return {
    apiVersion: 'v1', kind: 'Namespace',
    metadata: {
      name: namespaceFor(runId),
      labels: { 'scaling.lab/run': runId, 'scaling.lab/lesson': lesson, 'scaling.lab/owner': 'dashboard' },
    },
  };
}

export async function runClusterState(runId, deps = realDeps) {
  const ns = namespaceFor(runId);
  try {
    const [podsRaw, slicesRaw, hpaRaw] = await Promise.all([
      deps.exec(kubectlBase(ns).concat(['get', 'pods', '-l', 'app=scaling-app', '-o', 'json'])).then((r) => r.stdout),
      deps.exec(kubectlBase(ns).concat(['get', 'endpointslices', '-l', 'kubernetes.io/service-name=app', '-o', 'json'])).then((r) => r.stdout),
      deps.exec(kubectlBase(ns).concat(['get', 'hpa', '-o', 'json'])).then((r) => r.stdout).catch(() => '{"items":[]}'),
    ]);
    const pods = JSON.parse(podsRaw).items.map((x) => ({
      name: x.metadata.name, phase: x.status.phase,
      ready: x.status.containerStatuses?.every((c) => c.ready) || false,
      terminating: Boolean(x.metadata.deletionTimestamp),
    }));
    const endpoints = JSON.parse(slicesRaw).items.flatMap((x) => x.endpoints || []).map((x) => ({
      pod: x.targetRef?.name, ready: x.conditions?.ready, terminating: x.conditions?.terminating,
    }));
    return { connected: true, pods, endpoints, hpa: parseHpa(JSON.parse(hpaRaw).items) };
  } catch {
    return { connected: false, pods: [], endpoints: [], hpa: null };
  }
}
// Parses Kubernetes quantity strings ("27", "3200m", "42m", "1e3", "10Ki")
// into plain numbers. Returns null for unknown forms instead of guessing.
export function parseQuantity(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const m = /^(-?[0-9.]+(?:[eE][+-]?[0-9]+)?)(n|u|m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/.exec(raw.trim());
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const factors = { n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6 };
  return value * (factors[m[2]] ?? 1);
}
export function parseHpa(items) {
  const hpa = (items || []).find((x) => x.spec?.scaleTargetRef?.name === 'app');
  if (!hpa) return null;
  const cpuMetric = hpa.status?.currentMetrics?.find((m) => m.type === 'Resource' && m.resource?.name === 'cpu');
  const extMetric = hpa.status?.currentMetrics?.find((m) => m.type === 'External');
  const extSpec = (hpa.spec?.metrics || []).find((m) => m.type === 'External');
  return {
    name: hpa.metadata.name, current: hpa.status?.currentReplicas, desired: hpa.status?.desiredReplicas,
    currentCPU: cpuMetric?.resource?.current?.averageUtilization ?? null,
    cpuTarget: (hpa.spec?.metrics || []).find((m) => m.type === 'Resource' && m.resource?.name === 'cpu')?.resource?.target?.averageUtilization ?? null,
    external: extMetric ? {
      name: extMetric.external?.metric?.name || extSpec?.external?.metric?.name || null,
      // Normalized per-pod request rate; raw strings retained for evidence.
      current: parseQuantity(extMetric.external?.current?.averageValue),
      currentRaw: extMetric.external?.current?.averageValue ?? null,
      target: parseQuantity(extSpec?.external?.target?.averageValue),
      targetRaw: extSpec?.external?.target?.averageValue ?? null,
    } : null,
    metrics: (hpa.spec?.metrics || []).map((m) => ({ type: m.type })),
  };
}

async function waitRunReady(runId, deps, expected = 2) {
  const until = Date.now() + 120000;
  let last = null;
  while (Date.now() < until) {
    last = await runClusterState(runId, deps);
    if (last.connected && last.pods.length === expected
      && last.pods.every((p) => p.ready && !p.terminating)
      && last.endpoints.filter((e) => e.ready && !e.terminating).length >= expected) return last;
    await deps.sleep(2000);
  }
  throw new Error(`Run ${runId} did not settle to exactly ${expected} Ready app pods (saw ${last?.pods.length ?? '?'} pods). Check kubectl --context kind-scaling-lab -n ${namespaceFor(runId)} get pods.`);
}

async function verifyRunScrape(runId, deps) {
  const query = upQueryForRun(runId);
  let count = 0;
  for (let i = 0; i < 12; i++) {
    const r = await deps.query(query);
    if (!r.stale) count = r.value;
    if (count >= 2) return count;
    await deps.sleep(5000);
  }
  throw new Error(`Prometheus is not scraping both app pods of run ${runId} (saw ${count}, need 2 for query ${query}). Open Status -> Targets via make prometheus-ui, or re-run make prometheus-up.`);
}

// Counts every run whose namespace may still be allocated: ready, creating,
// deleting, degraded, and cleanup-failed all hold (or may hold) cluster
// resources. Only deleted and failed (namespace provably gone) free a slot.
const TERMINAL_RUN_STATUS = new Set(['deleted', 'failed']);
export function activeRuns() {
  return [...runs.values()].filter((r) => !TERMINAL_RUN_STATUS.has(r.status));
}

export function describeRun(run) {
  return {
    id: run.id, lesson: run.lesson, namespace: run.ns, status: run.status,
    createdAt: run.createdAt, error: run.error || null, steps: run.steps,
    cleanup: run.cleanup || null,
    appUrl: run.status === 'ready' && run.forwardPort ? `/app/${run.id}/fast` : null,
    statusStats: clientOutcomes(run.events),
    load: run.load ? run.load.state() : { active: false },
    readopted: Boolean(run.readopted),
    scenario: run.scenario || null,
    mode: run.mode || null,
    scenarioRunning: Boolean(run.scenarioRunning),
    actionRunning: Boolean(run.actionRunning),
    hasPendingLong: Boolean(run.pendingLong),
    actions: run.actions || 0,
    resultStatus: run.result?.status || null,
    resources: {
      appReplicas: runConfig(run.lesson).replicas, appCpuRequest: '100m', appMemoryRequest: '64Mi',
      edgeReplicas: 1, scaler: runConfig(run.lesson).scaler || 'none',
      note: 'Fixed footprint per run: 1–3 app pods (100m/64Mi each) + 1 edge pod. Active-run limit keeps laptop usage bounded.',
    },
  };
}

export function beginRun(lesson, onEvent, deps = realDeps) {
  if (!RUN_LESSONS.has(lesson)) throw Object.assign(new Error(`Unknown run lesson: ${lesson}. Expected one of ${[...RUN_LESSONS].join(', ')}.`), { status: 400 });
  if (activeRuns().length >= MAX_ACTIVE_RUNS) {
    throw Object.assign(new Error(`Run limit reached (${MAX_ACTIVE_RUNS} active runs: ${activeRuns().map((r) => r.id).join(', ')}). Clean up a run before creating another.`), { status: 409 });
  }
  let id = deps.genId();
  for (let guard = 0; runs.has(id) && guard < 5; guard++) id = deps.genId();
  if (runs.has(id)) throw Object.assign(new Error('Could not allocate a fresh run id. Retry.'), { status: 503 });
  const ns = namespaceFor(id);
  const run = {
    id, ns, lesson, status: 'creating', createdAt: new Date().toISOString(),
    error: null, steps: [], events: [], timeline: createHistory(), result: null,
    load: null, forward: null, forwardPort: null, prev: null,
  };
  runs.set(id, run);
  return run;
}

export async function finishRun(run, onEvent, deps = realDeps) {
  const { id, ns, lesson } = run;
  const step = (sid, detail) => {
    run.steps.push({ at: new Date().toISOString(), step: sid, detail });
    onEvent('run', { run: id, step: sid, text: `${sid}: ${detail}` });
  };
  try {
    step('create-namespace', `Creating namespace ${ns} with run/lesson/owner labels.`);
    await deps.apply(null, namespaceManifest(id, lesson));
    step('apply-manifests', 'Applying fixed app, edge, and scaler manifests scoped to the run namespace.');
    const { scaler } = runConfig(lesson);
    const objs = [...appManifests(id, ns, lesson), ...edgeManifests(ns)];
    if (lesson === 'downstream') objs.push(...depManifests(ns));
    if (scaler === 'keda') objs.push(scaledObjectManifest(id, ns));
    if (scaler === 'cpu-hpa') objs.push(cpuHpaManifest(ns));
    for (const obj of objs) {
      await deps.apply(ns, obj);
    }
    step('wait-rollout', 'Waiting for app and edge rollouts.');
    await deps.exec(kubectlBase(ns).concat(['rollout', 'status', 'deployment/app', '--timeout=180s'])).then((r) => r.stdout);
    await deps.exec(kubectlBase(ns).concat(['rollout', 'status', 'deployment/edge', '--timeout=180s'])).then((r) => r.stdout);
    step('wait-ready', `Waiting for exactly ${runConfig(lesson).replicas} Ready, non-terminating app pods and Ready endpoints.`);
    await waitRunReady(id, deps, runConfig(lesson).replicas);
    if (lesson === 'prometheus') {
      step('verify-scrape', `Verifying Prometheus scrapes all run targets (${upQueryForRun(id)}).`);
      var targets = await verifyRunScrape(id, deps);
    }
    if (scaler === 'keda') {
      step('verify-scaler', 'Verifying the KEDA ScaledObject is present for the run deployment.');
      await deps.exec(kubectlBase(ns).concat(['get', 'scaledobject', 'app-prometheus', '-o', 'name']));
    }
    if (scaler === 'cpu-hpa') {
      step('verify-scaler', 'Verifying the CPU HPA is present for the run deployment.');
      await deps.exec(kubectlBase(ns).concat(['get', 'hpa', 'app', '-o', 'name']));
    }
    step('start-route', 'Starting the run traffic route (edge port-forward).');
    const fwd = await deps.forward(id);
    run.forward = fwd; run.forwardPort = fwd.port;
    run.status = 'ready';
    pushMilestone(run.timeline, { kind: 'run', text: `Run ${id} ready in ${ns} (${runConfig(lesson).replicas} app pod(s)${lesson === 'prometheus' ? `, ${targets} Prometheus targets` : scaler === 'keda' ? ', KEDA scaler active' : scaler === 'cpu-hpa' ? ', CPU HPA active' : ', autoscaling disabled'})}.`, detail: 'Traffic for this run is routed to its own edge; other runs are unaffected.', observer: 'run controller' });
    return run;
  } catch (error) {
    // Creation rollback is idempotent: delete --ignore-not-found waits for
    // removal, so success frees the slot. Only a failed delete retains a
    // cleanup-failed record (which keeps its slot) instead.
    try {
      await deps.exec(kubectlBase(null).concat(['delete', 'namespace', ns, '--ignore-not-found'])).then((r) => r.stdout);
    } catch (deleteError) {
      run.status = 'cleanup-failed';
      run.error = `Creation failed (${error.message}) and rollback could not delete ${ns}: ${deleteError.message}`;
      run.cleanupAttempts = (run.cleanupAttempts || 0) + 1;
      throw new Error(run.error);
    }
    run.status = 'failed';
    run.error = error.message;
    try { if (run.forward) run.forward.close(); } catch { /* ignore */ }
    throw error;
  }
}

export async function createRun(lesson, onEvent, deps = realDeps) {
  return finishRun(beginRun(lesson, onEvent, deps), onEvent, deps);
}

export function buildArchive(run) {
  return {
    run: run.id, lesson: run.lesson, namespace: run.ns, createdAt: run.createdAt,
    archivedAt: new Date().toISOString(), status: run.status, error: run.error,
    ended: run.ended || null,
    steps: run.steps, load: run.load ? run.load.state() : null,
    queue: run.queue ? run.queue.stats() : null,
    result: run.result, timeline: run.timeline, events: run.events,
  };
}

export async function cleanupRun(runId, resultsDir, deps = realDeps) {
  const run = runs.get(validateRunId(runId));
  if (!run) throw Object.assign(new Error(`Unknown run: ${runId}`), { status: 404 });
  if (run.status === 'deleted') return run;
  if (run.status === 'deleting') throw Object.assign(new Error(`Run ${runId} cleanup is already in progress.`), { status: 409 });
  if (run.status === 'creating') throw Object.assign(new Error(`Run ${runId} is still being created. Wait for it to become ready (or fail) before cleanup.`), { status: 409 });
  if (run.scenarioRunning) throw Object.assign(new Error(`Run ${runId} has a scenario running. Wait for it before cleanup.`), { status: 409 });
  if (run.actionRunning) throw Object.assign(new Error(`Run ${runId} has a learner action running. Wait for it before cleanup.`), { status: 409 });
  if (run.pendingLong) throw Object.assign(new Error(`Run ${runId} has a long request in flight. Terminate it (terminate-serving) before cleanup.`), { status: 409 });
  run.status = 'deleting';
  run.error = null;
  run.cleanupAttempts = (run.cleanupAttempts || 0) + 1;
  const progress = (stage, detail, completed) => {
    run.cleanup = { stage, detail, completed, total: 4, updatedAt: new Date().toISOString() };
  };
  try {
    // Stop traffic first and await in-flight requests, so final counts are
    // stable before the snapshot is taken. Queue exercises stop too: their
    // drain settles every in-flight request, keeping the archive immutable.
    progress('stop-traffic', 'Stopping traffic and waiting for in-flight requests…', 0);
    if (run.load?.active) await run.load.stop('stopped by run cleanup');
    if (run.queue?.active) await run.queue.stop('stopped by run cleanup');
    progress('archive-evidence', 'Saving and verifying the evidence snapshot…', 1);
    const archive = structuredClone(buildArchive(run));
    try {
      await mkdir(resultsDir, { recursive: true });
      const file = `${resultsDir}/archive-${runId}.json`;
      await writeFile(file, JSON.stringify(archive, null, 2));
      JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      throw new Error(`Evidence snapshot could not be persisted: ${error.message}`);
    }
    archives.set(runId, archive);
    progress('close-route', 'Closing the run traffic route…', 2);
    try { if (run.forward) run.forward.close(); } catch { /* ignore */ }
    run.forward = null;
    progress('delete-namespace', `Waiting for Kubernetes to delete ${run.ns}…`, 3);
    // Idempotent retry: delete --ignore-not-found waits for removal, so a
    // successful delete means the namespace is gone and the slot is freed.
    // Only a failed delete retains the cleanup-failed record and its slot.
    try {
      await deps.exec(kubectlBase(null).concat(['delete', 'namespace', run.ns, '--ignore-not-found'])).then((r) => r.stdout);
    } catch (error) {
      run.status = 'cleanup-failed';
      run.error = `Namespace deletion failed: ${error.message}`;
      throw Object.assign(new Error(run.error), { status: 502 });
    }
    run.status = 'deleted';
    progress('complete', 'Run closed. Evidence stays downloadable.', 4);
    return run;
  } catch (error) {
    if (run.status === 'deleting') {
      run.status = 'cleanup-failed';
      run.error = error.message;
    }
    throw error;
  }
}
