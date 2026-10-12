import test from 'node:test';
import assert from 'node:assert/strict';
import { decideTick, createQueueRun, QUEUE_BOUNDS } from './queue.mjs';

function harness() {
  const scales = [];
  let workers = 1;
  return {
    scales,
    getWorkers: async () => workers,
    setWorkers: async (n) => { scales.push(n); workers = n; },
    request: async () => ({ ok: true }),
    events: [],
  };
}

test('decideTick scales on backlog within bounds', () => {
  assert.equal(decideTick({ backlog: 9, workers: 1 }), 'up');
  assert.equal(decideTick({ backlog: 9, workers: 5 }), 'hold', 'max workers hold');
  assert.equal(decideTick({ backlog: 0, workers: 3 }), 'down');
  assert.equal(decideTick({ backlog: 0, workers: 1 }), 'hold', 'min workers hold');
  assert.equal(decideTick({ backlog: 4, workers: 2 }), 'hold');
});

test('queue serves real arrivals and stops with settled counters', async () => {
  const h = harness();
  const q = createQueueRun({ request: h.request, getWorkers: h.getWorkers, setWorkers: h.setWorkers, emit: (t, d) => h.events.push([t, d]) });
  await q.start({ arrivalRps: 20, jobMs: 100 });
  await new Promise((r) => setTimeout(r, 1200));
  const mid = q.stats();
  assert.ok(mid.arrived > 5, `arrivals flowed (${mid.arrived})`);
  assert.equal(mid.offered, mid.arrived + mid.shed, 'offered arrival accounting includes shed');
  const stopped = await q.stop('test');
  assert.equal(stopped.active, false);
  const completed = stopped.completed;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(q.stats().completed, completed, 'counters frozen after stop: archive stays immutable');
});

test('no scale writes happen after stop, even with a held worker read', async () => {
  const h = harness();
  let release;
  const held = new Promise((r) => { release = r; });
  const q = createQueueRun({
    request: h.request,
    getWorkers: () => held.then(() => 1),
    setWorkers: h.setWorkers,
    emit: () => {},
  });
  // 9 backlog items with auto on: a tick would decide 'up' and scale to 2.
  await q.start({ arrivalRps: 1, jobMs: 1000 });
  for (let i = 0; i < 9; i++) q.jobs.push({ enqueuedAt: Date.now() });
  q.auto = true;
  const tickP = q.tick();
  const stopP = q.stop('test end');
  release();
  await Promise.all([tickP, stopP]);
  assert.deepEqual(h.scales, [], 'held tick performed no scale write after stop');
  assert.equal(q.stats().active, false);
});

test('restart resets counters instead of inheriting them', async () => {
  const h = harness();
  const q = createQueueRun({ request: h.request, getWorkers: h.getWorkers, setWorkers: h.setWorkers, emit: () => {} });
  await q.start({ arrivalRps: 20, jobMs: 100 });
  await new Promise((r) => setTimeout(r, 600));
  await q.stop('first');
  assert.ok(q.stats().arrived > 0);
  await q.start({ arrivalRps: 1, jobMs: 1000 });
  const fresh = q.stats();
  assert.equal(fresh.arrived, 0);
  assert.equal(fresh.completed, 0);
  assert.equal(fresh.ticks.length, 0);
  await q.stop('second');
});

test('auto mode scales workers up under backlog', async () => {
  const h = harness();
  const q = createQueueRun({ request: () => new Promise(() => {}), getWorkers: h.getWorkers, setWorkers: h.setWorkers, emit: () => {} });
  await q.start({ arrivalRps: 20, jobMs: 1000, auto: true });
  for (let i = 0; i < 12; i++) q.jobs.push({ enqueuedAt: Date.now() });
  await q.tick();
  assert.deepEqual(h.scales, [2], 'backlog above watermark scales 1 → 2');
  await q.stop('test');
});
