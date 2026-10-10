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
  assert.ok(events.every(([t]) => t === 'sample' || t === 'http-result'), 'successes emit sample, never request milestones (http-result is render-free accounting)');
  const fresh = await runAction(run, 'fresh-batch', {}, emit, deps);
  assert.equal(fresh.requests, 8);
  assert.deepEqual(ACTIONS.connections, ['reuse-batch', 'fresh-batch', 'demo-404', 'demo-500']);
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

test('failed pre-pod retries are accounted once each; eventual completion accounted once', async () => {
  const run = { id: 'aaaabbbb', ns: 'scaling-run-aaaabbbb', lesson: 'shutdown', forwardPort: 18888, pendingLong: null };
  const deps = fakeDeps();
  let release;
  const gate = new Promise((r) => { release = r; });
  let attempts = 0;
  deps.startRequest = () => {
    attempts++;
    if (attempts <= 2) {
      return {
        headers: Promise.resolve({ pod: null, status: 502, error: 'bad gateway' }),
        done: Promise.resolve({ ok: false, complete: true, status: 502, ms: 12 }),
      };
    }
    return {
      headers: Promise.resolve({ pod: 'app-x-1', requestId: 'req-9' }),
      done: gate.then(() => ({ ok: true, complete: true, status: 200, pod: 'app-x-1', requestId: 'req-9', ms: 8000 })),
    };
  };
  const events = [];
  const out = await runAction(run, 'start-long', { mode: 'graceful' }, (t, d) => events.push([t, d]), deps);
  assert.equal(out.pod, 'app-x-1');
  release();
  await new Promise((r) => setTimeout(r, 20));
  const accounted = events.filter(([t]) => t === 'http-result');
  assert.equal(accounted.length, 3, 'two failed attempts plus one completion, none duplicated');
  assert.deepEqual(accounted.map(([, d]) => d.status ?? d.error), [502, 502, 200]);
  assert.equal(events.filter(([t]) => t === 'request').length, 2, 'one failure trace per failed attempt');
  assert.ok(events.some(([t]) => t === 'slow-end'), 'completion emitted through pending logic');
});

test('all retries failing still leaves observed errors instead of no observations', async () => {
  const run = { id: 'aaaabbbb', ns: 'scaling-run-aaaabbbb', lesson: 'shutdown', forwardPort: 18888, pendingLong: null };
  const deps = fakeDeps();
  deps.startRequest = () => ({
    headers: Promise.resolve({ pod: null, status: 502, error: 'bad gateway' }),
    done: Promise.resolve({ ok: false, complete: true, status: 502, ms: 9 }),
  });
  const events = [];
  await assert.rejects(runAction(run, 'start-long', { mode: 'graceful' }, (t, d) => events.push([t, d]), deps), /did not reach a pod/);
  assert.equal(events.filter(([t]) => t === 'http-result').length, 5, 'every bounded retry attempt accounted once');
  assert.equal(events.filter(([t]) => t === 'request').length, 5, 'every attempt leaves a failure trace');
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
