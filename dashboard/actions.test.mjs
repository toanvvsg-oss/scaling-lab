import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, runAction } from './actions.mjs';

function fakeDeps() {
  const calls = [];
  let n = 0;
  const req = (over = {}) => ({
    headers: Promise.resolve({ pod: 'app-x-1', requestId: `req-${++n}`, edgeConnection: '7', appConnection: '3', ...(over.headers || {}) }),
    done: Promise.resolve({ ok: true, complete: true, status: 200, pod: 'app-x-1', requestId: `req-${n}`, edgeConnection: '7', appConnection: '3', ms: 5, body: '{}', ...(over.done || {}) }),
  });
  return {
    calls,
    watches: [],
    httpAgent: () => ({ destroy() {} }),
    sleep: async () => {},
    startRequest: (path, agent) => { calls.push(path); return req(); },
    kubectlIn: async (...a) => { calls.push(a.join(' ')); return 'ok'; },
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
