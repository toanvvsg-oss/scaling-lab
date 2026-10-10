import http from 'node:http';
import { kubectlIn, startRequest, traffic, watchPodLogs } from './runner.mjs';

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
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const realDeps = { kubectlIn, startRequest, traffic, sleep, httpAgent: (o) => new http.Agent(o), watchLogs: (pod, emit, ns) => watchPodLogs(pod, emit, ns) };

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
        const pending = { kind: action, pod: headers.pod, requestId: headers.requestId, startedAt: new Date().toISOString(), task: lastTask, agent, stopWatch, completed: false };
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
              ? { pod: done.pod || pending.pod, requestId: pending.requestId, complete: done.complete, ms: done.ms, error: done.error }
              : { pod: done.pod || pending.pod, requestId: pending.requestId, complete: done.complete, ms: done.ms, error: done.error, ticks: countTicks(done.body) });
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
        const result = { ...done, pod: pending.pod, requestId: pending.requestId };
        if (pending.kind !== 'start-long') result.ticks = countTicks(done.body);
        emit(pending.kind === 'start-long' ? 'slow-end' : 'stream-end', { pod: result.pod, requestId: result.requestId, complete: result.complete, ms: result.ms, error: result.error, ticks: result.ticks });
        return { action, pod: pending.pod, requestId: pending.requestId, complete: result.complete, ms: result.ms, error: result.error, ticks: result.ticks };
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
