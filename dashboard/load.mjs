import http from 'node:http';

// Phases are fractions of the session duration, so steady/ramp/burst behave
// distinguishably over time instead of differing only in starting rate.
export const PROFILES = {
  steady: {
    label: 'Steady load', path: '/fast', minRps: 5, maxRps: 30, step: 5,
    phases: [{ label: 'hold', rps: 15, frac: 1 }],
  },
  ramp: {
    label: 'Ramp load', path: '/fast', minRps: 5, maxRps: 30, step: 5,
    phases: [
      { label: 'warm', rps: 5, frac: 0.25 },
      { label: 'climb', rps: 12, frac: 0.25 },
      { label: 'high', rps: 20, frac: 0.25 },
      { label: 'peak', rps: 28, frac: 0.25 },
    ],
  },
  burst: {
    label: 'Burst load', path: '/fast', minRps: 5, maxRps: 40, step: 5,
    phases: [
      { label: 'spike', rps: 30, frac: 0.2 },
      { label: 'peak', rps: 38, frac: 0.2 },
      { label: 'settle', rps: 12, frac: 0.6 },
    ],
  },
};

// CPU-work variants drive the /cpu endpoint so the CPU HPA has something to
// observe. Rates stay low: 120ms of burn per request adds up fast.
export const CPU_PROFILES = {
  steady: {
    label: 'Steady CPU load', path: '/cpu?ms=120', minRps: 2, maxRps: 10, step: 2,
    phases: [{ label: 'hold', rps: 6, frac: 1 }],
  },
  ramp: {
    label: 'Ramp CPU load', path: '/cpu?ms=120', minRps: 2, maxRps: 10, step: 2,
    phases: [
      { label: 'warm', rps: 2, frac: 0.25 },
      { label: 'climb', rps: 4, frac: 0.25 },
      { label: 'high', rps: 6, frac: 0.25 },
      { label: 'peak', rps: 9, frac: 0.25 },
    ],
  },
  burst: {
    label: 'Burst CPU load', path: '/cpu?ms=120', minRps: 2, maxRps: 12, step: 2,
    phases: [
      { label: 'spike', rps: 10, frac: 0.2 },
      { label: 'peak', rps: 12, frac: 0.2 },
      { label: 'settle', rps: 4, frac: 0.6 },
    ],
  },
};

export const LOAD_LIMITS = {
  maxRps: 40,
  maxDurationMs: 5 * 60 * 1000,
  minDurationMs: 30 * 1000,
  endpoint: 'http://127.0.0.1:8080',
};

export function profileSet(cpu) {
  return cpu ? CPU_PROFILES : PROFILES;
}

export function validateProfile(profile, cpu = false) {
  const set = profileSet(cpu);
  if (!Object.hasOwn(set, profile)) throw new Error(`Unknown profile: ${profile}`);
  return profile;
}

function get(endpoint, path, agent, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.get(`${endpoint}${path}`, { agent, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (x) => chunks.push(x));
      res.on('end', () => resolve({
        ok: res.statusCode === 200, status: res.statusCode, ms: Date.now() - started,
        pod: res.headers['x-pod'], requestId: res.headers['x-request-id'],
        edgeConnection: res.headers['x-edge-connection'], appConnection: res.headers['x-app-connection'],
      }));
      res.on('error', (error) => resolve({ ok: false, error: error.code || error.message, ms: Date.now() - started }));
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', (error) => resolve({ ok: false, error: error.code || error.message, ms: Date.now() - started }));
  });
}

export class LoadSession {
  constructor(emit, opts = {}) {
    this.emit = emit;
    this.endpoint = opts.endpoint || LOAD_LIMITS.endpoint;
    this.cpu = Boolean(opts.cpu);
    this.path = opts.path || null;
    this.active = false;
    this.profile = null;
    this.targetRps = 0;
    this.manualDelta = 0;
    this.phaseIndex = 0;
    this.durationMs = 0;
    this.startedAt = null;
    this.stoppedAt = null;
    this.total = 0;
    this.succeeded = 0;
    this.failures = 0;
    this.offeredLastSecond = 0;
    this.achievedLastSecond = 0;
    this._stopRequested = false;
    this._inflight = new Set();
  }

  def() {
    return profileSet(this.cpu)[this.profile];
  }

  phaseAt(elapsedMs) {
    const phases = this.def().phases;
    let acc = 0;
    for (let i = 0; i < phases.length; i++) {
      acc += phases[i].frac * this.durationMs;
      if (elapsedMs < acc || i === phases.length - 1) return i;
    }
    return 0;
  }

  phaseLabel() {
    return this.def().phases[this.phaseIndex]?.label || '';
  }

  effectiveRps(phaseIndex = this.phaseIndex) {
    const def = this.def();
    const base = def.phases[phaseIndex]?.rps ?? def.phases[0].rps;
    return Math.min(def.maxRps, LOAD_LIMITS.maxRps, Math.max(def.minRps, base + this.manualDelta));
  }

  state() {
    return {
      active: this.active,
      profile: this.profile,
      cpu: this.cpu,
      path: this.path || this.def()?.path,
      targetRps: this.targetRps,
      phaseIndex: this.phaseIndex,
      phaseLabel: this.active ? this.phaseLabel() : null,
      durationMs: this.durationMs,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
      total: this.total,
      succeeded: this.succeeded,
      failures: this.failures,
      offeredLastSecond: this.offeredLastSecond,
      achievedLastSecond: this.achievedLastSecond,
    };
  }

  async start(profile, opts = {}) {
    if (this.active) throw new Error('A load session is already running. Stop it before starting another.');
    validateProfile(profile, this.cpu);
    this.active = true;
    this.profile = profile;
    this.manualDelta = 0;
    this.phaseIndex = 0;
    this.durationMs = Math.min(LOAD_LIMITS.maxDurationMs, Math.max(LOAD_LIMITS.minDurationMs, opts.durationMs || 180000));
    this.targetRps = this.effectiveRps(0);
    this.startedAt = Date.now();
    this.stoppedAt = null;
    this.total = 0;
    this.succeeded = 0;
    this.failures = 0;
    this.offeredLastSecond = 0;
    this.achievedLastSecond = 0;
    this._stopRequested = false;
    this._inflight.clear();
    this._gen = (this._gen || 0) + 1;
    this._loopDone = null;
    this.emit('load', { text: `Load started: ${profile} (${this.phaseLabel()}) at ${this.targetRps} req/s for ${Math.round(this.durationMs / 1000)}s`, profile, rps: this.targetRps, phase: this.phaseLabel() });
    const gen = this._gen;
    this._loopDone = this._loop(gen).catch((error) => this.emit('error', { text: `Load loop error: ${error.message}` }));
    return this.state();
  }

  setRps(next) {
    const def = this.def();
    const clamped = Math.min(def.maxRps, LOAD_LIMITS.maxRps, Math.max(def.minRps, next));
    this.manualDelta = clamped - (def.phases[this.phaseIndex]?.rps ?? 0);
    if (clamped !== this.targetRps) {
      this.targetRps = clamped;
      this.emit('load', { text: `Offered load set to ${clamped} req/s (${this.profile}, manual)`, profile: this.profile, rps: clamped });
    }
    return this.state();
  }

  increase() {
    if (!this.active) throw new Error('No active load session.');
    return this.setRps(this.targetRps + this.def().step);
  }

  decrease() {
    if (!this.active) throw new Error('No active load session.');
    return this.setRps(this.targetRps - this.def().step);
  }

  async _drain() {
    const deadline = Date.now() + 10000;
    while (this._inflight.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    for (const p of this._inflight) {
      try { await Promise.race([p, new Promise((r) => setTimeout(r, 500))]); } catch { /* ignore */ }
    }
  }

  async stop(reason = 'stopped') {
    if (!this.active) return this.state();
    // Generation bump retires the pacing loop even if it is asleep on its
    // timer; awaiting loop exit guarantees no two generators ever overlap.
    this._gen += 1;
    this._stopRequested = true;
    this.emit('load', { text: `Load stopping (${reason}); waiting for ${this._inflight.size} in-flight requests…`, profile: this.profile, rps: 0 });
    if (this._loopDone) await this._loopDone.catch(() => {});
    await this._drain();
    this.active = false;
    this.stoppedAt = Date.now();
    this.offeredLastSecond = 0;
    this.achievedLastSecond = 0;
    this.emit('load', { text: `Load stopped after ${this.total} requests (${this.succeeded} ok, ${this.failures} failures)`, profile: this.profile, rps: 0 });
    return this.state();
  }

  async _loop(gen) {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 24 });
    const path = this.path || this.def().path;
    let windowStart = Date.now();
    let windowOffered = 0;
    let windowOk = 0;
    let sampleCount = 0;
    try {
      while (!this._stopRequested && gen === this._gen) {
        const elapsed = Date.now() - this.startedAt;
        if (elapsed > this.durationMs) {
          this.emit('load', { text: `Load finished its ${Math.round(this.durationMs / 1000)}s plan; settling ${this._inflight.size} in-flight requests…`, profile: this.profile, rps: 0 });
          break;
        }
        const phase = this.phaseAt(elapsed);
        if (phase !== this.phaseIndex) {
          this.phaseIndex = phase;
          this.targetRps = this.effectiveRps(phase);
          this.emit('load', { text: `Load phase ${this.phaseLabel()}: ${this.targetRps} req/s`, profile: this.profile, rps: this.targetRps, phase: this.phaseLabel() });
        }
        const intervalMs = 1000 / Math.max(1, this.targetRps);
        const task = get(this.endpoint, path, agent).then((r) => {
          this.total += 1;
          if (r.ok) {
            this.succeeded += 1;
            windowOk += 1;
            if (++sampleCount % 10 === 0) {
              this.emit('sample', { pod: r.pod, ok: true, ms: r.ms, requestId: r.requestId, edgeConnection: r.edgeConnection, appConnection: r.appConnection });
            }
          } else {
            this.failures += 1;
            this.emit('request', { pod: r.pod, ok: false, status: r.status, error: r.error, ms: r.ms, requestId: r.requestId });
          }
          this._inflight.delete(task);
          return r;
        });
        this._inflight.add(task);
        windowOffered += 1;
        const now = Date.now();
        const windowElapsed = (now - windowStart) / 1000;
        if (windowElapsed >= 1) {
          // Normalize by actual elapsed time: the loop window can exceed 1s.
          this.offeredLastSecond = Math.round(windowOffered / windowElapsed);
          this.achievedLastSecond = Math.round(windowOk / windowElapsed);
          windowStart = now;
          windowOffered = 0;
          windowOk = 0;
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      // Natural completion settles every in-flight request before reporting
      // inactive, so final counters never change afterwards.
      await this._drain();
    } finally {
      agent.destroy();
      if (this.active) {
        this.active = false;
        this.stoppedAt = Date.now();
        this.offeredLastSecond = 0;
        this.achievedLastSecond = 0;
        this.emit('load', { text: `Load settled: ${this.total} requests (${this.succeeded} ok, ${this.failures} failures)`, profile: this.profile, rps: 0 });
      }
    }
  }
}
