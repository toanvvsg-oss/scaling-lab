import http from 'node:http';

export const PROFILES = {
  steady: { initialRps: 15, minRps: 5, maxRps: 30, step: 5, label: 'Steady load' },
  ramp: { initialRps: 5, minRps: 5, maxRps: 30, step: 5, label: 'Ramp load' },
  burst: { initialRps: 30, minRps: 5, maxRps: 40, step: 5, label: 'Burst load' },
};

export const LOAD_LIMITS = {
  maxRps: 40,
  maxDurationMs: 5 * 60 * 1000,
  endpoint: 'http://127.0.0.1:8080',
  path: '/fast',
};

export function validateProfile(profile) {
  if (!Object.hasOwn(PROFILES, profile)) throw new Error(`Unknown profile: ${profile}`);
  return profile;
}

function get(endpoint, path, agent, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.get(`${endpoint}${path}`, { agent, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (x) => chunks.push(x));
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, ms: Date.now() - started, pod: res.headers['x-pod'] }));
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
    this.path = opts.path || LOAD_LIMITS.path;
    this.active = false;
    this.profile = null;
    this.targetRps = 0;
    this.startedAt = null;
    this.stoppedAt = null;
    this.total = 0;
    this.failures = 0;
    this.offeredLastSecond = 0;
    this._stopRequested = false;
    this._inflight = new Set();
    this._secondBuckets = [];
  }

  state() {
    return {
      active: this.active,
      profile: this.profile,
      targetRps: this.targetRps,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
      total: this.total,
      failures: this.failures,
      offeredLastSecond: this.offeredLastSecond,
    };
  }

  async start(profile) {
    if (this.active) throw new Error('A load session is already running. Stop it before starting another.');
    validateProfile(profile);
    this.active = true;
    this.profile = profile;
    this.targetRps = PROFILES[profile].initialRps;
    this.startedAt = Date.now();
    this.stoppedAt = null;
    this.total = 0;
    this.failures = 0;
    this._stopRequested = false;
    this._inflight.clear();
    this._secondBuckets = [];
    this.emit('load', { text: `Load started: ${profile} at ${this.targetRps} req/s`, profile, rps: this.targetRps });
    this._loop().catch((error) => this.emit('error', { text: `Load loop error: ${error.message}` }));
    return this.state();
  }

  setRps(next) {
    const def = PROFILES[this.profile];
    const clamped = Math.min(def.maxRps, LOAD_LIMITS.maxRps, Math.max(def.minRps, next));
    if (clamped !== this.targetRps) {
      this.targetRps = clamped;
      this.emit('load', { text: `Offered load set to ${clamped} req/s (${this.profile})`, profile: this.profile, rps: clamped });
    }
    return this.state();
  }

  increase() {
    if (!this.active) throw new Error('No active load session.');
    return this.setRps(this.targetRps + PROFILES[this.profile].step);
  }

  decrease() {
    if (!this.active) throw new Error('No active load session.');
    return this.setRps(this.targetRps - PROFILES[this.profile].step);
  }

  async stop(reason = 'stopped') {
    if (!this.active) return this.state();
    this._stopRequested = true;
    this.emit('load', { text: `Load stopping (${reason}); waiting for ${this._inflight.size} in-flight requests…`, profile: this.profile, rps: 0 });
    const deadline = Date.now() + 10000;
    while (this._inflight.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    for (const p of this._inflight) {
      try { await Promise.race([p, new Promise((r) => setTimeout(r, 500))]); } catch { /* ignore */ }
    }
    this.active = false;
    this.stoppedAt = Date.now();
    this.offeredLastSecond = 0;
    this.emit('load', { text: `Load stopped after ${this.total} requests (${this.failures} failures)`, profile: this.profile, rps: 0 });
    return this.state();
  }

  async _loop() {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 24 });
    let windowStart = Date.now();
    let windowCount = 0;
    try {
      while (!this._stopRequested) {
        if (Date.now() - this.startedAt > LOAD_LIMITS.maxDurationMs) {
          this.emit('load', { text: 'Load auto-stopped after 5 minute safety limit', profile: this.profile, rps: 0 });
          break;
        }
        const intervalMs = 1000 / Math.max(1, this.targetRps);
        const task = get(this.endpoint, this.path, agent).then((r) => {
          this.total += 1;
          if (!r.ok) {
            this.failures += 1;
            this.emit('request', { pod: r.pod, ok: false, status: r.status, error: r.error, ms: r.ms });
          }
          this._inflight.delete(task);
          return r;
        });
        this._inflight.add(task);
        windowCount += 1;
        const now = Date.now();
        if (now - windowStart >= 1000) {
          this.offeredLastSecond = windowCount;
          this._secondBuckets.push({ at: new Date().toISOString(), offered: windowCount, target: this.targetRps });
          if (this._secondBuckets.length > 900) this._secondBuckets.shift();
          windowStart = now;
          windowCount = 0;
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    } finally {
      agent.destroy();
      if (this.active) {
        this.active = false;
        this.stoppedAt = Date.now();
        this.offeredLastSecond = 0;
      }
    }
  }
}
