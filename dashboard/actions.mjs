import http from 'node:http';
import { spawn } from 'node:child_process';
import { kubectlIn, startRequest, traffic, watchPodLogs } from './runner.mjs';
import { createQueueRun, QUEUE_BOUNDS } from './queue.mjs';

// Narrow per-run learner actions. Each action does one observable thing inside
// the run namespace and returns a summary for the UI. The one-click verifier
// stays available as an automatic shortcut.
export const ACTIONS = {
  connections: ['reuse-batch', 'fresh-batch'],
  timeouts: ['short-gap', 'long-gap'],
  shutdown: ['start-long', 'terminate-serving'],
  streaming: ['start-stream', 'terminate-serving'],
  rollout: ['bg-start', 'bg-stop', 'trigger-rollout'],
  autoscale: [],
  prometheus: [],
  capacity: [],
  resources: ['raise-request', 'tighten-limit', 'oom-burst', 'restore-res'],
  hpareact: [],
  signals: ['q-start', 'q-more', 'q-less', 'q-auto', 'q-stop'],
  downstream: [],
  pending: ['constrain', 'restore'],
  disruptions: ['pdb-set', 'evict-one', 'delete-one', 'bg-start', 'bg-stop', 'trigger-rollout'],
  gateway: [],
  capstone: [],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnApply(ns, obj) {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', ['--context', 'kind-scaling-lab', '-n', ns, 'apply', '-f', '-'], { timeout: 60000 });
    let err = '';
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`kubectl apply failed: ${err.trim().slice(0, 200)}`))));
    child.stdin.write(JSON.stringify(obj));
    child.stdin.end();
  });
}

function spawnEvict(ns, pod) {
  return new Promise((resolve) => {
    const child = spawn('kubectl', ['--context', 'kind-scaling-lab', '-n', ns, 'create', '--raw', `/api/v1/namespaces/${ns}/pods/${pod}/eviction`, '-f', '-'], { timeout: 30000 });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', (e) => resolve({ code: 1, out: '', err: String(e?.message || e) }));
    child.on('close', (code) => resolve({ code: code ?? 1, out: out.trim(), err: err.trim() }));
    child.stdin.write(JSON.stringify({ apiVersion: 'policy/v1', kind: 'Eviction', metadata: { name: pod, namespace: ns } }));
    child.stdin.end();
  });
}

// All cluster writes through the action layer go through these two injected
// hooks (namespace + object are fixed by the caller, never learner-supplied),
// so tests can stub them and stay hermetic.
const realDeps = {
  kubectlIn, startRequest, traffic, sleep,
  httpAgent: (o) => new http.Agent(o),
  watchLogs: (pod, emit, ns) => watchPodLogs(pod, emit, ns),
  apply: (ns, obj) => spawnApply(ns, obj),
  evictRaw: (ns, pod) => spawnEvict(ns, pod),
};

// After a rollout the edge needs Ready endpoints before a pinned request can
// land on a pod. Polls EndpointSlices for at least two ready endpoints.
export async function waitRunEndpoints(ns, deps = realDeps, minReady = 2, timeoutMs = 60000) {
  const until = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < until) {
    try {
      const raw = await deps.kubectlIn(ns, 'get', 'endpointslices', '-l', 'kubernetes.io/service-name=app', '-o', 'json');
      last = JSON.parse(raw).items
        .flatMap((x) => x.endpoints || [])
        .filter((e) => e.conditions?.ready && !e.conditions?.terminating).length;
      if (last >= minReady) return last;
    } catch { /* retry until timeout */ }
    await deps.sleep(2000);
  }
  throw new Error(`No Ready app endpoints appeared in ${ns} (saw ${last}, need ${minReady}). Check the app rollout and Service endpoints.`);
}

export async function runAction(run, action, input = {}, emit = () => {}, deps = realDeps) {
  const allowed = ACTIONS[run.lesson] || [];
  if (!allowed.includes(action)) {
    throw Object.assign(new Error(`Unknown action ${action} for lesson ${run.lesson}. Expected one of ${allowed.join(', ') || 'none'}.`), { status: 400 });
  }
  const ns = run.ns;
  const base = `http://127.0.0.1:${run.forwardPort}`;
  const agent = deps.httpAgent({ keepAlive: true });
  try {
    switch (action) {
      case 'reuse-batch': {
        const ids = [];
        for (let i = 0; i < 8; i++) {
          const r = await deps.startRequest('/fast', agent, base).done;
          ids.push(r.edgeConnection);
          emit('sample', { group: 'keep-alive', ...strip(r) });
        }
        return { action, requests: 8, edgeIds: ids, shared: new Set(ids).size === 1 };
      }
      case 'fresh-batch': {
        const ids = [];
        for (let i = 0; i < 8; i++) {
          const r = await deps.startRequest('/fast', false, base).done;
          ids.push(r.edgeConnection);
          emit('sample', { group: 'new connection', ...strip(r) });
        }
        return { action, requests: 8, edgeIds: ids, allDistinct: new Set(ids).size === ids.length };
      }
      case 'short-gap':
      case 'long-gap': {
        const gapMs = action === 'short-gap' ? 1000 : 6500;
        const a = deps.httpAgent({ keepAlive: true, maxSockets: 1 });
        const first = await deps.startRequest('/fast', a, base).done;
        emit('sample', { group: `${gapMs}ms idle`, ...strip(first) });
        await deps.sleep(gapMs);
        const second = await deps.startRequest('/fast', a, base).done;
        emit('sample', { group: `${gapMs}ms idle`, ...strip(second) });
        a.destroy();
        return {
          action, gapMs,
          clientReused: first.edgeConnection === second.edgeConnection,
          upstream: { before: [first.pod, first.appConnection], after: [second.pod, second.appConnection] },
        };
      }
      case 'start-long':
      case 'start-stream': {
        if (run.pendingLong) throw Object.assign(new Error('A long request is already in flight in this run. Terminate it first.'), { status: 409 });
        if (run.lesson === 'shutdown') {
          const mode = input.mode === 'abrupt' ? 'abrupt' : 'graceful';
          emit('note', { text: `Deploying ${mode} shutdown mode` });
          await deps.kubectlIn(ns, 'set', 'env', 'deployment/app', `SHUTDOWN_MODE=${mode}`);
          await deps.kubectlIn(ns, 'rollout', 'status', 'deployment/app', '--timeout=180s');
          run.mode = mode;
        }
        const path = action === 'start-long' ? '/slow?ms=8000' : '/stream';
        await waitRunEndpoints(ns, deps);
        const agent = deps.httpAgent({ keepAlive: true });
        // Retry only pre-headers failures (edge 502 / reset with no serving
        // pod yet). Once headers arrive the request exists — never duplicate it.
        let headers = null;
        let lastTask = null;
        let lastError = 'unknown';
        for (let attempt = 0; attempt < 5 && !headers?.pod; attempt++) {
          if (attempt > 0) await deps.sleep(2000);
          const task = deps.startRequest(path, agent, base);
          lastTask = task;
          headers = await task.headers;
          if (!headers.pod) {
            lastError = `HTTP ${headers.status ?? '?'} ${headers.error || 'no x-pod header'}`;
            task.done.catch(() => {});
          }
        }
        if (!headers?.pod) {
          agent.destroy();
          throw new Error(`Long request did not reach a pod after rollout recovery (last: ${lastError}). Check the app Deployment and edge route, then retry start.`);
        }
        const stopWatch = deps.watchLogs(headers.pod, emit, ns);
        const pending = { kind: action, pod: headers.pod, requestId: headers.requestId, status: headers.status, startedAt: new Date().toISOString(), task: lastTask, agent, stopWatch, completed: false };
        run.pendingLong = pending;
        emit(action === 'start-long' ? 'slow-start' : 'stream-start', { ...headers });
        // Natural completion clears the slot, releases the watcher/agent, and
        // emits the completion so the learner can retry or clean up.
        pending.task.done.then((done) => {
          if (run.pendingLong !== pending) return;
          run.pendingLong = null;
          pending.completed = true;
          try { pending.stopWatch(); } catch { /* ignore */ }
          try { pending.agent.destroy(); } catch { /* ignore */ }
          emit(pending.kind === 'start-long' ? 'slow-end' : 'stream-end',
            pending.kind === 'start-long'
              ? { pod: done.pod || pending.pod, requestId: pending.requestId, status: done.status ?? pending.status, complete: done.complete, ms: done.ms, error: done.error }
              : { pod: done.pod || pending.pod, requestId: pending.requestId, status: done.status ?? pending.status, complete: done.complete, ms: done.ms, error: done.error, ticks: countTicks(done.body) });
        });
        return { action, pod: headers.pod, requestId: headers.requestId };
      }
      case 'terminate-serving': {
        const pending = run.pendingLong;
        if (!pending) throw Object.assign(new Error('No long request in flight. Start one first.'), { status: 400 });
        if (pending.completed) {
          run.pendingLong = null;
          throw Object.assign(new Error('That request already completed. Start another one to terminate it.'), { status: 400 });
        }
        run.pendingLong = null;
        emit('pod-delete', { pod: pending.pod });
        await deps.kubectlIn(ns, 'delete', 'pod', pending.pod, '--wait=false');
        const done = await pending.task.done;
        pending.completed = true;
        try { pending.stopWatch(); } catch { /* ignore */ }
        try { pending.agent.destroy(); } catch { /* ignore */ }
        const result = { ...done, pod: pending.pod, requestId: pending.requestId, status: done.status ?? pending.status };
        if (pending.kind !== 'start-long') result.ticks = countTicks(done.body);
        emit(pending.kind === 'start-long' ? 'slow-end' : 'stream-end', { pod: result.pod, requestId: result.requestId, status: result.status, complete: result.complete, ms: result.ms, error: result.error, ticks: result.ticks });
        return { action, pod: pending.pod, requestId: pending.requestId, status: result.status, complete: result.complete, ms: result.ms, error: result.error, ticks: result.ticks };
      }
      case 'bg-start': {
        if (!run.load) throw new Error(`Run ${run.id} is not ready for traffic yet.`);
        if (run.load.active) throw Object.assign(new Error('Background traffic is already running.'), { status: 409 });
        await run.load.start('steady', { durationMs: 300000 });
        return { action, profile: 'steady' };
      }
      case 'bg-stop': {
        if (!run.load?.active) throw Object.assign(new Error('No background traffic running.'), { status: 400 });
        await run.load.stop('stopped by learner');
        return { action, total: run.load.total };
      }
      case 'constrain': {
        // Dependency-injected kubectl only: never call the runner's real
        // cluster helpers here, so action tests stay hermetic.
        await deps.kubectlIn(ns, 'patch', 'deployment/app', '-p', '{"spec":{"template":{"spec":{"nodeSelector":{"scaling.lab/nonexistent":"true"}}}}}');
        await deps.kubectlIn(ns, 'scale', 'deployment/app', '--replicas=5');
        emit('note', { text: 'Constraint applied: impossible nodeSelector, desired 5. Waiting for Pending to settle.' });
        for (let i = 0; i < 9; i++) {
          await deps.sleep(5000);
          try {
            const raw = await deps.kubectlIn(ns, 'get', 'pods', '-l', 'app=scaling-app', '-o', 'json');
            const items = JSON.parse(raw).items || [];
            if (items.length >= 5 && items.filter((p) => p.status?.phase === 'Pending').length >= 2) break;
          } catch { /* keep polling */ }
        }
        emit('note', { text: 'Read pod phases and scheduler events.' });
        return { action, constrained: true };
      }
      case 'restore': {
        await deps.kubectlIn(ns, 'patch', 'deployment/app', '--type=json', '-p', '[{"op":"remove","path":"/spec/template/spec/nodeSelector"}]').catch(() => {});
        await deps.kubectlIn(ns, 'scale', 'deployment/app', '--replicas=2');
        await deps.kubectlIn(ns, 'rollout', 'status', 'deployment/app', '--timeout=180s');
        emit('note', { text: 'Constraint removed: deployment back to 2 schedulable replicas.' });
        return { action, restored: true };
      }
      case 'raise-request': {
        await deps.kubectlIn(ns, 'patch', 'deployment/app', '-p', '{"spec":{"template":{"spec":{"containers":[{"name":"app","resources":{"requests":{"cpu":"400m"}}}}]}}}');
        await deps.kubectlIn(ns, 'rollout', 'status', 'deployment/app', '--timeout=180s');
        emit('note', { text: 'CPU request raised to 400m (limit untouched). Watch HPA utilization move at constant traffic.' });
        return { action, cpuRequest: '400m' };
      }
      case 'tighten-limit': {
        // Paired valid values: request 100m ≤ limit 150m (the API rejects
        // request > limit, so both are set together).
        await deps.kubectlIn(ns, 'patch', 'deployment/app', '-p', '{"spec":{"template":{"spec":{"containers":[{"name":"app","resources":{"requests":{"cpu":"100m"},"limits":{"cpu":"150m"}}}}]}}}');
        await deps.kubectlIn(ns, 'rollout', 'status', 'deployment/app', '--timeout=180s');
        emit('note', { text: 'CPU pinned to request 100m / limit 150m. Read throttling from cpu.stat, not from latency alone.' });
        return { action, cpuRequest: '100m', cpuLimit: '150m' };
      }
      case 'oom-burst': {
        await deps.kubectlIn(ns, 'patch', 'deployment/app', '-p', '{"spec":{"template":{"spec":{"containers":[{"name":"app","resources":{"limits":{"memory":"96Mi"}}}}]}}}');
        await deps.kubectlIn(ns, 'rollout', 'status', 'deployment/app', '--timeout=180s');
        const burst = Array.from({ length: 8 }, () => deps.startRequest('/alloc?mb=32&holdMs=1500', false, base).done);
        await Promise.all(burst.map((p) => p.catch((e) => e)));
        await deps.sleep(8000);
        const raw = await deps.kubectlIn(ns, 'get', 'pods', '-l', 'app=scaling-app', '-o', 'json');
        let restarts = 0;
        const reasons = [];
        for (const p of JSON.parse(raw).items || []) {
          for (const c of p.status?.containerStatuses || []) {
            restarts += c.restartCount || 0;
            if (c.lastState?.terminated?.reason) reasons.push(`${p.metadata.name}:${c.lastState.terminated.reason}`);
          }
        }
        const oom = reasons.find((x) => /OOMKilled/.test(x)) || reasons[0] || null;
        emit('note', { text: `Memory burst done: ${restarts} restarts, termination ${oom || 'none recorded'}.` });
        return { action, restarts, reason: oom };
      }
      case 'restore-res': {
        await deps.kubectlIn(ns, 'patch', 'deployment/app', '-p', '{"spec":{"template":{"spec":{"containers":[{"name":"app","resources":{"requests":{"cpu":"100m","memory":"64Mi"},"limits":{"cpu":"1","memory":"128Mi"}}}}]}}}');
        await deps.kubectlIn(ns, 'rollout', 'status', 'deployment/app', '--timeout=180s');
        emit('note', { text: 'Resources restored to 100m/1 CPU and 64Mi/128Mi memory.' });
        return { action, restored: true };
      }
      case 'pdb-set': {
        await deps.apply(ns, {
          apiVersion: 'policy/v1', kind: 'PodDisruptionBudget',
          metadata: { name: 'app-pdb', namespace: ns },
          spec: { maxUnavailable: 1, selector: { matchLabels: { app: 'scaling-app' } } },
        });
        emit('note', { text: 'PDB applied (maxUnavailable 1). Ordered evictions honor it; deletes do not.' });
        return { action, pdb: 'app-pdb' };
      }
      case 'evict-one': {
        const raw = await deps.kubectlIn(ns, 'get', 'pods', '-l', 'app=scaling-app', '-o', 'json');
        const target = (JSON.parse(raw).items || []).find((p) => !p.metadata?.deletionTimestamp && p.status?.containerStatuses?.every((c) => c.ready));
        if (!target) throw Object.assign(new Error('No Ready app pod to evict right now.'), { status: 409 });
        const r = await deps.evictRaw(ns, target.metadata.name);
        const text = `${r.out} ${r.err}`.trim();
        const allowed = r.code === 0;
        emit('note', { text: `Eviction of ${target.metadata.name}: ${allowed ? 'ALLOWED' : `refused (${text.slice(0, 140)})`}.` });
        return { action, pod: target.metadata.name, allowed, detail: text.slice(0, 300) };
      }
      case 'delete-one': {
        const raw = await deps.kubectlIn(ns, 'get', 'pods', '-l', 'app=scaling-app', '-o', 'json');
        const target = (JSON.parse(raw).items || [])[0];
        if (!target) throw new Error('No app pod to delete right now.');
        await deps.kubectlIn(ns, 'delete', 'pod', target.metadata.name, '--wait=false');
        emit('pod-delete', { pod: target.metadata.name });
        emit('note', { text: `Direct delete of ${target.metadata.name} succeeded — PDBs do not stop deletes.` });
        return { action, pod: target.metadata.name, deleted: true };
      }
      case 'q-start': {
        if (run.queue?.active) throw Object.assign(new Error('A queue exercise is already running in this run.'), { status: 409 });
        const workersOf = async () => Number(JSON.parse(await deps.kubectlIn(ns, 'get', 'deployment/app', '-o', 'json')).spec?.replicas ?? 1);
        run.queue = createQueueRun({
          request: () => deps.startRequest('/slow?ms=800', false, base).done,
          getWorkers: workersOf,
          setWorkers: async (n) => { await deps.kubectlIn(ns, 'scale', 'deployment/app', `--replicas=${n}`); },
          emit,
        });
        const stats = await run.queue.start({ arrivalRps: 4, jobMs: 800, auto: false });
        emit('note', { text: 'Queue exercise started: 4 arrivals/s of real 800ms work. Scale workers manually (q-more/q-less) or enable backlog auto (q-auto).' });
        return { action, ...stats };
      }
      case 'q-more':
      case 'q-less': {
        if (!run.queue?.active) throw Object.assign(new Error('Start the queue exercise first (q-start).'), { status: 400 });
        return { action, ...(await run.queue.nudge(action === 'q-more' ? 1 : -1)) };
      }
      case 'q-auto': {
        if (!run.queue?.active) throw Object.assign(new Error('Start the queue exercise first (q-start).'), { status: 400 });
        return { action, ...(await run.queue.setAuto(!run.queue.auto)) };
      }
      case 'q-stop': {
        if (!run.queue?.active) throw Object.assign(new Error('No queue exercise running.'), { status: 400 });
        const stats = await run.queue.stop('stopped by learner');
        return { action, ...stats };
      }
      case 'trigger-rollout': {
        emit('rollout', { text: 'Starting rolling update' });
        await deps.kubectlIn(ns, 'set', 'env', 'deployment/app', `LAB_REV=${Date.now()}`);
        await deps.kubectlIn(ns, 'rollout', 'status', 'deployment/app', '--timeout=180s');
        return { action, rolled: true };
      }
      default:
        throw Object.assign(new Error(`Unknown action: ${action}`), { status: 400 });
    }
  } finally {
    agent.destroy();
  }
}

function strip(r) {
  const { body, ...rest } = r;
  return rest;
}

// Tick count in a streaming response body, same format the grader counts.
export function countTicks(body) {
  return (body || '').trim().split('\n').filter(Boolean).length;
}
