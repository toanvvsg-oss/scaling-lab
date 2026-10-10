import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHistory, pushMilestone } from './timeline.mjs';
import { queryPrometheus, upQueryForRun } from './prometheus.mjs';

const runFile = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const MAX_ACTIVE_RUNS = 2;
// Every lesson can run isolated. Only the autoscaling lessons add a scaler;
// the other five get app + edge only.
export const RUN_LESSONS = new Set(['connections', 'timeouts', 'shutdown', 'rollout', 'streaming', 'autoscale', 'prometheus']);
const SCALER_LESSON = { autoscale: 'cpu-hpa', prometheus: 'keda' };
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

export const runs = new Map();
export const archives = new Map();

// Re-adopt run namespaces left behind by a dashboard restart. Strictly scoped:
// the name must match scaling-run-<8 hex>, the owner label must be exactly
// "dashboard", and the lesson must be one the dashboard can drive. Anything
// else is never touched. Adopted runs resume sampling under a new edge
// forward; their previous in-memory events are gone (archive files persist).
export async function adoptOrphanRuns() {
  const adopted = [];
  let items = [];
  try {
    const raw = await kubectl('get', 'namespaces', '-l', 'scaling.lab/owner=dashboard', '-o', 'json');
    items = JSON.parse(raw).items;
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
    const present = await kubectl('-n', name, 'get', 'deployment/app', 'deployment/edge', '-o', 'name').catch(() => null);
    const run = {
      id, ns: name, lesson: labels['scaling.lab/lesson'], status: present ? 'ready' : 'degraded',
      error: present ? null : 'Run namespace is missing its app or edge deployment.',
      createdAt: ns.metadata.creationTimestamp || new Date().toISOString(),
      steps: [], events: [], timeline: createHistory(), result: null,
      load: null, forward: null, forwardPort: null, prev: null, readopted: true,
    };
    if (present) {
      try {
        const fwd = await startEdgeForward(id);
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

async function kubectl(...args) {
  const { stdout } = await runFile('kubectl', kubectlBase(null).concat(args), { timeout: 180000 });
  return stdout.trim();
}

function applyJson(ns, obj) {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', [...kubectlBase(ns), 'apply', '-f', '-'], { timeout: 60000 });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`kubectl apply failed: ${stderr.trim()}`))));
    child.stdin.write(JSON.stringify(obj));
    child.stdin.end();
  });
}

const APP_IMAGE = 'scaling-lab-app:local';

function appManifests(runId, ns) {
  const podLabels = { app: 'scaling-app', labrun: runId };
  return [
    {
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'app', namespace: ns, labels: { ...podLabels, 'scaling.lab/run': runId } },
      spec: {
        replicas: 2,
        strategy: { rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
        selector: { matchLabels: podLabels },
        template: {
          metadata: { labels: podLabels },
          spec: {
            terminationGracePeriodSeconds: 30,
            containers: [{
              name: 'app', image: APP_IMAGE, imagePullPolicy: 'Never',
              ports: [{ containerPort: 3000 }],
              env: [{ name: 'SHUTDOWN_MODE', value: 'graceful' }, { name: 'SHUTDOWN_MS', value: '24000' }],
              resources: { requests: { cpu: '100m', memory: '64Mi' }, limits: { cpu: '1', memory: '128Mi' } },
              lifecycle: { preStop: { exec: { command: ['sh', '-c', 'sleep 2'] } } },
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

export async function runClusterState(runId) {
  const ns = namespaceFor(runId);
  try {
    const [podsRaw, slicesRaw, hpaRaw] = await Promise.all([
      kubectl('-n', ns, 'get', 'pods', '-l', 'app=scaling-app', '-o', 'json'),
      kubectl('-n', ns, 'get', 'endpointslices', '-l', 'kubernetes.io/service-name=app', '-o', 'json'),
      kubectl('-n', ns, 'get', 'hpa', '-o', 'json').catch(() => '{"items":[]}'),
    ]);
    const pods = JSON.parse(podsRaw).items.map((x) => ({
      name: x.metadata.name, phase: x.status.phase,
      ready: x.status.containerStatuses?.every((c) => c.ready) || false,
      terminating: Boolean(x.metadata.deletionTimestamp),
    }));
    const endpoints = JSON.parse(slicesRaw).items.flatMap((x) => x.endpoints || []).map((x) => ({
      pod: x.targetRef?.name, ready: x.conditions?.ready, terminating: x.conditions?.terminating,
    }));
    const hpa = JSON.parse(hpaRaw).items.find((x) => x.spec?.scaleTargetRef?.name === 'app');
    return {
      connected: true, pods, endpoints,
      hpa: hpa && {
        name: hpa.metadata.name, current: hpa.status?.currentReplicas, desired: hpa.status?.desiredReplicas,
        metrics: (hpa.spec?.metrics || []).map((m) => ({ type: m.type })),
      },
    };
  } catch {
    return { connected: false, pods: [], endpoints: [], hpa: null };
  }
}

async function waitRunReady(runId, progress) {
  const until = Date.now() + 120000;
  let last = null;
  while (Date.now() < until) {
    last = await runClusterState(runId);
    if (last.connected && last.pods.length === 2
      && last.pods.every((p) => p.ready && !p.terminating)
      && last.endpoints.filter((e) => e.ready && !e.terminating).length >= 2) return last;
    await sleep(2000);
  }
  throw new Error(`Run ${runId} did not settle to exactly two Ready app pods (saw ${last?.pods.length ?? '?'} pods). Check kubectl --context kind-scaling-lab -n ${namespaceFor(runId)} get pods.`);
}

async function verifyRunScrape(runId) {
  const query = upQueryForRun(runId);
  let count = 0;
  for (let i = 0; i < 12; i++) {
    const r = await queryPrometheus(query);
    if (!r.stale) count = r.value;
    if (count >= 2) return count;
    await sleep(5000);
  }
  throw new Error(`Prometheus is not scraping both app pods of run ${runId} (saw ${count}, need 2 for query ${query}). Open Status -> Targets via make prometheus-ui, or re-run make prometheus-up.`);
}

function startEdgeForward(runId) {
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

export function activeRuns() {
  return [...runs.values()].filter((r) => r.status === 'ready' || r.status === 'creating');
}

export function describeRun(run) {
  return {
    id: run.id, lesson: run.lesson, namespace: run.ns, status: run.status,
    createdAt: run.createdAt, error: run.error || null, steps: run.steps,
    load: run.load ? run.load.state() : { active: false },
    readopted: Boolean(run.readopted),
    scenario: run.scenario || null,
    scenarioRunning: Boolean(run.scenarioRunning),
    resultStatus: run.result?.status || null,
    resources: {
      appReplicas: 2, appCpuRequest: '100m', appMemoryRequest: '64Mi',
      edgeReplicas: 1, note: 'Fixed footprint per run: 2 app pods (100m/64Mi each) + 1 edge pod. Active-run limit keeps laptop usage bounded.',
    },
  };
}

export async function createRun(lesson, onEvent) {
  if (!RUN_LESSONS.has(lesson)) throw new Error(`Unknown run lesson: ${lesson}. Expected one of ${[...RUN_LESSONS].join(', ')}.`);
  if (activeRuns().length >= MAX_ACTIVE_RUNS) {
    throw new Error(`Run limit reached (${MAX_ACTIVE_RUNS} active runs: ${activeRuns().map((r) => r.id).join(', ')}). Clean up a run before creating another.`);
  }
  const id = createRunId();
  const ns = namespaceFor(id);
  const run = {
    id, ns, lesson, status: 'creating', createdAt: new Date().toISOString(),
    error: null, steps: [], events: [], timeline: createHistory(), result: null,
    load: null, forward: null, forwardPort: null, prev: null,
  };
  const step = (sid, detail) => {
    run.steps.push({ at: new Date().toISOString(), step: sid, detail });
    onEvent('run', { run: id, step: sid, text: `${sid}: ${detail}` });
  };
  runs.set(id, run);
  try {
    step('create-namespace', `Creating namespace ${ns} with run/lesson/owner labels.`);
    await applyJson(null, namespaceManifest(id, lesson));
    step('apply-manifests', 'Applying fixed app, edge, and scaler manifests scoped to the run namespace.');
    const objs = [...appManifests(id, ns), ...edgeManifests(ns)];
    if (SCALER_LESSON[lesson] === 'keda') objs.push(scaledObjectManifest(id, ns));
    if (SCALER_LESSON[lesson] === 'cpu-hpa') objs.push(cpuHpaManifest(ns));
    for (const obj of objs) {
      await applyJson(ns, obj);
    }
    step('wait-rollout', 'Waiting for app and edge rollouts.');
    await kubectl('-n', ns, 'rollout', 'status', 'deployment/app', '--timeout=180s');
    await kubectl('-n', ns, 'rollout', 'status', 'deployment/edge', '--timeout=180s');
    step('wait-ready', 'Waiting for exactly two Ready, non-terminating app pods and Ready endpoints.');
    await waitRunReady(id, step);
    if (lesson === 'prometheus') {
      step('verify-scrape', `Verifying Prometheus scrapes both run targets (${upQueryForRun(id)}).`);
      var targets = await verifyRunScrape(id);
    }
    if (lesson === 'autoscale') {
      step('verify-scaler', 'Verifying the CPU HPA is present for the run deployment.');
      await kubectl('-n', ns, 'get', 'hpa', 'app', '-o', 'name');
    }
    step('start-route', 'Starting the run traffic route (edge port-forward).');
    const fwd = await startEdgeForward(id);
    run.forward = fwd; run.forwardPort = fwd.port;
    run.status = 'ready';
    pushMilestone(run.timeline, { kind: 'run', text: `Run ${id} ready in ${ns}${lesson === 'prometheus' ? ` (${targets} Prometheus targets)` : lesson === 'autoscale' ? ' (CPU HPA active)' : ''}.`, detail: 'Traffic for this run is routed to its own edge; other runs are unaffected.', observer: 'run controller' });
    return run;
  } catch (error) {
    run.status = 'failed';
    run.error = error.message;
    try { if (run.forward) run.forward.close(); } catch { /* ignore */ }
    await kubectl('delete', 'namespace', ns, '--ignore-not-found').catch(() => {});
    throw error;
  }
}

export function buildArchive(run) {
  return {
    run: run.id, lesson: run.lesson, namespace: run.ns, createdAt: run.createdAt,
    archivedAt: new Date().toISOString(), status: run.status, error: run.error,
    steps: run.steps, load: run.load ? run.load.state() : null,
    result: run.result, timeline: run.timeline, events: run.events,
  };
}

export async function cleanupRun(runId, resultsDir) {
  const run = runs.get(validateRunId(runId));
  if (!run) throw new Error(`Unknown run: ${runId}`);
  if (run.status === 'deleting' || run.status === 'deleted') return run;
  run.status = 'deleting';
  const archive = buildArchive(run);
  archives.set(runId, archive);
  try {
    await mkdir(resultsDir, { recursive: true });
    await writeFile(`${resultsDir}/archive-${runId}.json`, JSON.stringify(archive, null, 2));
  } catch { /* archive file is best-effort; memory copy remains */ }
  if (run.load?.active) await run.load.stop('stopped by run cleanup').catch(() => {});
  try { if (run.forward) run.forward.close(); } catch { /* ignore */ }
  await kubectl('delete', 'namespace', run.ns, '--ignore-not-found').catch(() => {});
  run.status = 'deleted';
  return run;
}
