// Real backlog-driven worker scaling (lesson 11 queue exercise).
//
// The queue data structure lives in the dashboard process — the UI labels it
// as such. The WORK is real: every job is an HTTP request against the run's
// own edge, and worker capacity is the run's real app Deployment replica
// count changed through the Kubernetes API. Nothing about the load or the
// scaling is simulated; only the queue itself is dashboard-hosted.
// Backlog is hard-capped: excess arrivals are counted as shed, never queued.
export const QUEUE_BOUNDS = { minWorkers: 1, maxWorkers: 5, maxBacklog: 200 };

export function decideTick({ backlog, workers, minW = QUEUE_BOUNDS.minWorkers, maxW = QUEUE_BOUNDS.maxWorkers, highWM = 8 }) {
  if (backlog > highWM && workers < maxW) return 'up';
  if (backlog === 0 && workers > minW) return 'down';
  return 'hold';
}

export function createQueueRun({ request, getWorkers, setWorkers, emit = () => {} }) {
  const q = {
    active: false,
    auto: false,
    jobs: [],
    shed: 0,
    arrived: 0,
    completed: 0,
    failed: 0,
    startedAt: null,
    ticks: [],
    zeroStreak: 0,
    arrivalRps: 4,
    jobMs: 800,
    arrivalTimer: null,
    dispatchTimer: null,
    tickTimer: null,
    inflight: new Set(),
    lastCompleted: 0,
    lastTickAt: null,
    tickRunning: false,
    tickDone: null,
    gen: 0,

    async start({ arrivalRps = 4, jobMs = 800, auto = false } = {}) {
      if (q.active) throw new Error('A queue exercise is already running in this run.');
      if (!(arrivalRps > 0 && arrivalRps <= 20)) throw new Error('arrivalRps must be within 1..20.');
      if (!(jobMs >= 100 && jobMs <= 2000)) throw new Error('jobMs must be within 100..2000.');
      // Fresh counters on every (re)start: a restarted queue never inherits
      // arrivals, completions, backlog, or ticks from the previous exercise.
      q.jobs = [];
      q.shed = 0;
      q.arrived = 0;
      q.completed = 0;
      q.failed = 0;
      q.ticks = [];
      q.zeroStreak = 0;
      q.inflight = new Set();
      q.lastCompleted = 0;
      q.lastTickAt = null;
      q.tickRunning = false;
      q.tickDone = null;
      q.active = true;
      q.auto = Boolean(auto);
      q.arrivalRps = arrivalRps;
      q.jobMs = jobMs;
      q.startedAt = Date.now();
      q.lastCompleted = 0;
      emit('queue', { text: `Queue started: ${arrivalRps} arrivals/s of ${jobMs}ms real work, workers scale 1..5${auto ? ' (backlog-driven auto)' : ' (manual scaling)'}.` });
      q.arrivalTimer = setInterval(() => {
        if (!q.active) return;
        if (q.jobs.length >= QUEUE_BOUNDS.maxBacklog) { q.shed += 1; return; }
        q.jobs.push({ enqueuedAt: Date.now() });
        q.arrived += 1;
      }, Math.max(20, Math.floor(1000 / arrivalRps)));
      q.dispatchTimer = setInterval(() => {
        if (!q.active) return;
        void q.pump();
      }, 100);
      q.tickTimer = setInterval(() => {
        void q.tick().catch((e) => emit('error', { text: `Queue tick failed: ${e.message}` }));
      }, 5000);
      return q.stats();
    },

    async pump() {
      const gen = q.gen;
      let workers = 1;
      try { workers = await getWorkers(); } catch { /* keep last */ }
      if (!q.active || gen !== q.gen) return;
      while (q.active && gen === q.gen && q.jobs.length > 0 && q.inflight.size < Math.max(1, workers) * 3) {
        const job = q.jobs.shift();
        const ageMs = Date.now() - job.enqueuedAt;
        const task = request(job)
          .then((r) => { if (r && r.ok) q.completed += 1; else q.failed += 1; return r; })
          .catch(() => { q.failed += 1; })
          .finally(() => { q.inflight.delete(task); });
        q.inflight.add(task);
        job.waitMs = ageMs;
      }
    },

    async tick() {
      // Serialize ticks: a slow tick never overlaps the next one.
      if (!q.active || q.tickRunning) return null;
      q.tickRunning = true;
      const gen = q.gen;
      const alive = () => q.active && gen === q.gen;
      q.tickDone = (async () => {
        try {
          let workers = 1;
          try { workers = await getWorkers(); } catch { /* keep last */ }
          if (!alive()) return null;
          const backlog = q.jobs.length;
          const oldestAgeMs = q.jobs.length ? Date.now() - q.jobs[0].enqueuedAt : 0;
          const now = Date.now();
          const elapsedSec = q.lastTickAt == null ? 5 : Math.max(0.5, (now - q.lastTickAt) / 1000);
          q.lastTickAt = now;
          const serviceRps = Math.round(((q.completed - q.lastCompleted) / elapsedSec) * 10) / 10;
          q.lastCompleted = q.completed;
          if (backlog === 0) q.zeroStreak += 1; else q.zeroStreak = 0;
          let decision = 'hold';
          let scaledTo = null;
          if (q.auto) {
            // Scale down only after two consecutive empty ticks to avoid flapping.
            const want = backlog === 0 && q.zeroStreak < 2 ? 'hold' : decideTick({ backlog, workers });
            decision = want;
            if (!alive()) return null;
            if (want === 'up') { scaledTo = workers + 1; await setWorkers(scaledTo); }
            if (want === 'down') { scaledTo = workers - 1; await setWorkers(scaledTo); }
            if (!alive()) return null;
          }
          const tick = {
            at: new Date().toISOString(), backlog, oldestAgeMs, workers,
            arrivalRps: q.arrivalRps, serviceRps, completed: q.completed, failed: q.failed, shed: q.shed,
            auto: q.auto, decision, scaledTo,
          };
          q.ticks.push(tick);
          if (q.ticks.length > 200) q.ticks.shift();
          emit('queue', { text: `Queue: backlog ${backlog}, oldest ${Math.round(oldestAgeMs)}ms, service ${serviceRps}/s, workers ${workers}${scaledTo != null ? ` → ${scaledTo}` : ''}.`, ...tick });
          return tick;
        } finally {
          q.tickRunning = false;
        }
      })();
      return q.tickDone;
    },

    async nudge(delta) {
      if (!q.active) throw new Error('Queue exercise is not running.');
      const workers = await getWorkers();
      const next = Math.min(QUEUE_BOUNDS.maxWorkers, Math.max(QUEUE_BOUNDS.minWorkers, workers + delta));
      if (next !== workers) await setWorkers(next);
      emit('queue', { text: `Workers manually set ${workers} → ${next} (backlog ${q.jobs.length}).` });
      return { workers: next };
    },

    async setAuto(on) {
      if (!q.active) throw new Error('Queue exercise is not running.');
      q.auto = Boolean(on);
      q.zeroStreak = 0;
      emit('queue', { text: `Backlog-driven auto-scaling ${q.auto ? 'enabled' : 'disabled'} (workers scale 1..5 from backlog).` });
      return { auto: q.auto };
    },

    async stop(reason = 'stopped') {
      if (!q.active && !q.tickRunning && q.inflight.size === 0) return q.stats();
      // Invalidate first: every pending tick/pump/scale rechecks this before
      // writing anything, so nothing mutates state after stop resolves.
      q.active = false;
      q.gen += 1;
      for (const t of [q.arrivalTimer, q.dispatchTimer, q.tickTimer]) {
        try { clearInterval(t); } catch { /* ignore */ }
      }
      q.arrivalTimer = q.dispatchTimer = q.tickTimer = null;
      // Settle the in-flight tick (it observes the invalidation above and
      // performs no scale writes), then settle every in-flight request.
      // Injected requests are timeout-bounded, so this drain cannot hang on a
      // wedged connection forever; counters are frozen only afterwards, which
      // keeps the archived evidence immutable.
      if (q.tickDone) await q.tickDone.catch(() => {});
      if (q.inflight.size > 0) await Promise.allSettled([...q.inflight]);
      emit('queue', { text: `Queue stopped (${reason}): ${q.arrived} arrived, ${q.completed} served, ${q.failed} failed, ${q.shed} shed past the ${QUEUE_BOUNDS.maxBacklog} cap.` });
      return q.stats();
    },

    stats() {
      return {
        active: q.active, auto: q.auto, backlog: q.jobs.length,
        oldestAgeMs: q.jobs.length ? Date.now() - q.jobs[0].enqueuedAt : 0,
        // Offered arrival accounting counts shed arrivals too: arrived alone
        // would undercount what the exercise offered the queue.
        offered: q.arrived + q.shed,
        arrived: q.arrived, completed: q.completed, failed: q.failed, shed: q.shed,
        arrivalRps: q.arrivalRps, jobMs: q.jobMs, ticks: q.ticks.slice(-5),
      };
    },
  };
  return q;
}
