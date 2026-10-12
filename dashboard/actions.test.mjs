import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, runAction } from './actions.mjs';

function fakeDeps() {
  const calls = [];
  let n = 0;
  let sleeps = 0;
  const slices = JSON.stringify({ items: [{ endpoints: [1, 2].map((i) => ({ targetRef: { name: `app-x-${i}` }, conditions: { ready: true, terminating: false } })) }] });
  const req = (over = {}) => ({
    headers: Promise.resolve({ pod: 'app-x-1', requestId: `req-${++n}`, edgeConnection: '7', appConnection: '3', ...(over.headers || {}) }),
    done: Promise.resolve({ ok: true, complete: true, status: 200, pod: 'app-x-1', requestId: `req-${n}`, edgeConnection: '7', appConnection: '3', ms: 5, body: '{}', ...(over.done || {}) }),
  });
  return {
    calls,
    get sleeps() { return sleeps; },
    httpAgent: () => ({ destroy() {} }),
    sleep: async () => {
      sleeps += 1;
      if (sleeps > 20) throw new Error('fake clock exhausted');
    },
    startRequest: (path, agent) => { calls.push(path); return req(); },
    kubectlIn: async (...a) => {
      const s = a.join(' ');
      calls.push(s);
      if (s.includes('get endpointslices')) return slices;
      return 'ok';
    },
    watchLogs: (pod, emit, ns) => { calls.push(`watch ${pod}`); let dead = false; return () => { dead = true; }; },
  };
}

function runFor(lesson) {
  return { id: 'aaaabbbb', ns: 'scaling-run-aaaabbbb', lesson, forwardPort: 18888, pendingLong: null, load: null };
}

test('connections batches distinguish shared from fresh sockets', async () => {
  const events = [];
  const emit = (t, d) => events.push([t, d]);
  const run = runFor('connections');
  const deps = fakeDeps();
  const reused = await runAction(run, 'reuse-batch', {}, emit, deps);
  assert.equal(reused.shared, true);
  assert.ok(events.every(([t]) => t === 'sample'), 'successes emit sample, never request milestones');
  const fresh = await runAction(run, 'fresh-batch', {}, emit, deps);
  assert.equal(fresh.requests, 8);
  assert.deepEqual(ACTIONS.connections, ['reuse-batch', 'fresh-batch']);
});

test('gap probes report client and upstream reuse', async () => {
  const run = runFor('timeouts');
  const short = await runAction(run, 'short-gap', {}, () => {}, fakeDeps());
  assert.equal(short.gapMs, 1000);
  assert.equal(short.clientReused, true);
});

test('long-request actions guard the pending slot', async () => {
  const run = runFor('shutdown');
  const deps = fakeDeps();
  let release;
  const gate = new Promise((r) => { release = r; });
  deps.startRequest = (path) => {
    deps.calls.push(path);
    return {
      headers: Promise.resolve({ pod: 'app-x-1', requestId: 'req-1' }),
      done: gate.then(() => ({ ok: true, complete: true, pod: 'app-x-1', ms: 8000 })),
    };
  };
  const started = await runAction(run, 'start-long', { mode: 'graceful' }, () => {}, deps);
  assert.equal(started.pod, 'app-x-1');
  assert.ok(started.requestId);
  assert.ok(deps.calls.some((c) => c.includes('SHUTDOWN_MODE=graceful')), 'guided start honors the visible mode');
  assert.ok(deps.calls.some((c) => c === 'watch app-x-1'), 'log watcher attached for preStop/SIGTERM traces');
  await assert.rejects(runAction(run, 'start-long', {}, () => {}, deps), /already in flight/);
  const terminating = runAction(run, 'terminate-serving', {}, () => {}, deps);
  release();
  const ended = await terminating;
  assert.equal(ended.complete, true);
  assert.ok(deps.calls.some((c) => c.includes('delete pod app-x-1')));
  await assert.rejects(runAction(run, 'terminate-serving', {}, () => {}, deps), /No long request/);
  await assert.rejects(runAction(run, 'reuse-batch', {}, () => {}, deps), /Unknown action/);
});

test('naturally completed requests clear the slot and reject termination', async () => {
  const run = runFor('streaming');
  let release;
  const gate = new Promise((r) => { release = r; });
  const deps = fakeDeps();
  const origStart = deps.startRequest;
  deps.startRequest = () => ({ headers: Promise.resolve({ pod: 'app-x-9', requestId: 'r9' }), done: gate.then(() => ({ ok: true, complete: true, pod: 'app-x-9', ms: 100 })) });
  void origStart;
  const events = [];
  await runAction(run, 'start-stream', {}, (t, d) => events.push([t, d]), deps);
  assert.ok(run.pendingLong, 'slot held while streaming');
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(run.pendingLong, null, 'natural completion clears the slot');
  assert.ok(events.some(([t]) => t === 'stream-end'), 'completion emitted');
  await assert.rejects(runAction(run, 'terminate-serving', {}, () => {}, deps), /No long request/);
});

test('rollout trigger runs kubectl in the run namespace', async () => {
  const run = runFor('rollout');
  const deps = fakeDeps();
  const out = await runAction(run, 'trigger-rollout', {}, () => {}, deps);
  assert.equal(out.rolled, true);
  assert.ok(deps.calls.some((c) => c.includes('LAB_REV')));
});

test('stream end carries tick counts and request ids', async () => {
  const { countTicks } = await import('./actions.mjs');
  assert.equal(countTicks(Array(20).fill('tick').join('\n') + '\n'), 20);
  assert.equal(countTicks(''), 0);
  assert.equal(countTicks(null), 0);
});

test('start-long waits for endpoints and retries only pre-headers failures', async () => {
  const run = { id: 'aaaabbbb', ns: 'scaling-run-aaaabbbb', lesson: 'shutdown', forwardPort: 18888, pendingLong: null };
  const deps = fakeDeps();
  let kubectlCalls = 0;
  const origKubectl = deps.kubectlIn;
  deps.kubectlIn = async (...a) => { kubectlCalls++; return origKubectl(...a); };
  let attempts = 0;
  deps.startRequest = () => {
    attempts++;
    if (attempts < 3) {
      return { headers: Promise.resolve({ pod: null, status: 502, error: 'bad gateway' }), done: Promise.resolve({ ok: false, complete: false, error: 'bad gateway' }) };
    }
    return {
      headers: Promise.resolve({ pod: 'app-x-1', requestId: 'req-9' }),
      done: new Promise(() => {}),
    };
  };
  const out = await runAction(run, 'start-long', { mode: 'graceful' }, () => {}, deps);
  assert.equal(out.pod, 'app-x-1');
  assert.equal(attempts, 3, 'two pre-headers 502s retried, third reached a pod');
  assert.ok(kubectlCalls >= 3, 'mode rollout plus endpoint wait ran first');
  run.pendingLong = null;
});

test('start-long reports HTTP status when no pod is ever reached', async () => {
  const run = { id: 'aaaabbbb', ns: 'scaling-run-aaaabbbb', lesson: 'shutdown', forwardPort: 18888, pendingLong: null };
  const deps = fakeDeps();
  deps.startRequest = () => ({
    headers: Promise.resolve({ pod: null, status: 502, error: 'bad gateway' }),
    done: Promise.resolve({ ok: false, complete: false, error: 'bad gateway' }),
  });
  await assert.rejects(runAction(run, 'start-long', {}, () => {}, deps), /HTTP 502/);
  assert.equal(run.pendingLong, null, 'no slot held without a serving pod');
});

test('pending constrain/restore use injected kubectl only', async () => {
  const run = runFor('pending');
  const deps = fakeDeps();
  const out = await runAction(run, 'constrain', {}, () => {}, deps);
  assert.equal(out.constrained, true);
  assert.ok(deps.calls.some((c) => c.includes('nodeSelector') && c.includes('scaling.lab/nonexistent')), 'constraint patch scoped to the run deployment');
  assert.ok(deps.calls.some((c) => c.includes('scale') && c.includes('--replicas=5')), 'scale to 5 via injected kubectl');
  const back = await runAction(run, 'restore', {}, () => {}, deps);
  assert.equal(back.restored, true);
  assert.ok(deps.calls.some((c) => c.includes('--replicas=2')), 'restore scales back via injected kubectl');
});

test('resources actions patch valid pairs and report OOM evidence', async () => {
  const run = runFor('resources');
  const deps = fakeDeps();
  const raised = await runAction(run, 'raise-request', {}, () => {}, deps);
  assert.equal(raised.cpuRequest, '400m');
  assert.ok(deps.calls.some((c) => c.includes('requests') && c.includes('400m')));
  const tight = await runAction(run, 'tighten-limit', {}, () => {}, deps);
  assert.equal(tight.cpuLimit, '150m');
  const patch = deps.calls.find((c) => c.includes('150m'));
  assert.ok(patch.includes('100m'), 'tighten sets request 100m together with limit 150m (request never exceeds limit)');
  const oomDeps = fakeDeps();
  const origOomKubectl = oomDeps.kubectlIn;
  oomDeps.kubectlIn = async (...a) => {
    const s = a.join(' ');
    if (s.includes('get pods')) {
      return JSON.stringify({ items: [{ metadata: { name: 'app-x-1' }, status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 1, lastState: { terminated: { reason: 'OOMKilled' } } }] } }] });
    }
    return origOomKubectl(...a);
  };
  const oom = await runAction(run, 'oom-burst', {}, () => {}, oomDeps);
  assert.equal(oom.restarts, 1);
  assert.match(oom.reason || '', /OOMKilled/);
  const back = await runAction(run, 'restore-res', {}, () => {}, deps);
  assert.equal(back.restored, true);
});

test('disruptions actions use injected apply and eviction', async () => {
  const run = runFor('disruptions');
  const deps = fakeDeps();
  deps.apply = async (ns, obj) => { deps.calls.push(`apply ${obj.kind}/${obj.metadata.name} maxUnavailable=${obj.spec.maxUnavailable}`); };
  deps.evictRaw = async (ns, pod) => { deps.calls.push(`evict ${pod}`); return { code: 0, out: 'eviction created', err: '' }; };
  deps.kubectlIn = async (...a) => {
    const s = a.join(' ');
    deps.calls.push(s);
    if (s.includes('get pods')) {
      return JSON.stringify({ items: [{ metadata: { name: 'app-x-1' }, status: { phase: 'Running', containerStatuses: [{ ready: true }] } }] });
    }
    return 'ok';
  };
  const pdb = await runAction(run, 'pdb-set', {}, () => {}, deps);
  assert.equal(pdb.pdb, 'app-pdb');
  const ev = await runAction(run, 'evict-one', {}, () => {}, deps);
  assert.equal(ev.allowed, true);
  assert.equal(ev.pod, 'app-x-1');
  const blocked = await runAction(run, 'evict-one', {}, () => {}, { ...deps, evictRaw: async () => ({ code: 1, out: '', err: 'Error from server (TooManyRequests): budgets' }) });
  assert.equal(blocked.allowed, false);
  const del = await runAction(run, 'delete-one', {}, () => {}, deps);
  assert.equal(del.deleted, true);
});

test('queue actions drive real request/scale hooks with bounds', async () => {
  const run = runFor('signals');
  const deps = fakeDeps();
  let workers = 1;
  const origKubectl = deps.kubectlIn;
  deps.kubectlIn = async (...a) => {
    const s = a.join(' ');
    deps.calls.push(s);
    if (s.includes('get deployment/app')) return JSON.stringify({ spec: { replicas: workers } });
    if (s.includes('--replicas=')) workers = Number(s.match(/--replicas=(\d)/)[1]);
    return origKubectl(...a);
  };
  const started = await runAction(run, 'q-start', {}, () => {}, deps);
  assert.equal(started.active, true);
  const more = await runAction(run, 'q-more', {}, () => {}, deps);
  assert.equal(more.workers, 2);
  assert.equal(workers, 2, 'worker capacity really changed');
  const auto = await runAction(run, 'q-auto', {}, () => {}, deps);
  assert.equal(auto.auto, true);
  await assert.rejects(runAction(run, 'q-start', {}, () => {}, deps), /already running/);
  const stopped = await runAction(run, 'q-stop', {}, () => {}, deps);
  assert.equal(stopped.active, false);
  await runAction(run, 'q-start', {}, () => {}, deps);
  await runAction(run, 'q-stop', {}, () => {}, deps);
});
