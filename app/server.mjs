import http from 'node:http';
import { randomUUID } from 'node:crypto';

const port = Number(process.env.PORT || 3000);
const pod = process.env.HOSTNAME || 'local';
const mode = process.env.SHUTDOWN_MODE || 'graceful';
const shutdownMs = Number(process.env.SHUTDOWN_MS || 24000);
let ready = true;
let active = 0;
let requestsTotal = 0;
let openSockets = 0;
let nextConnection = 0;
const connections = new WeakMap();
// Completed-response counters by bounded dimensions only: method is a fixed
// allowlist, route is a normalized learner-route name (never a raw path),
// status is the numeric code the app actually wrote. Transport-level failures
// (resets/timeouts with no response) never invent a status here; they stay
// visible only in client-observed dashboard stats, since /metrics cannot see
// proxy-emitted 502/504.
const responsesByStatus = new Map();
// Known learner routes expose zero before their first response so a scrape
// can establish a counter baseline before a short error burst.
const learnerRoutes = ['fast', 'slow', 'cpu', 'stream', 'alloc', 'dep', 'other'];
for (const route of learnerRoutes) responsesByStatus.set(`GET|${route}|200|2xx`, 0);

function routeName(pathname) {
  if (pathname === '/fast') return 'fast';
  if (pathname === '/slow') return 'slow';
  if (pathname === '/cpu') return 'cpu';
  if (pathname === '/stream') return 'stream';
  if (pathname === '/alloc') return 'alloc';
  if (pathname === '/dep') return 'dep';
  return 'other';
}

function methodName(method) {
  if (method === 'GET' || method === 'POST' || method === 'HEAD') return method;
  return 'OTHER';
}

function statusClassOf(status) {
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  return 'other';
}

// Simple response-duration histogram by bounded route label only, for p95
// panels. Buckets in seconds; _sum/_count enable histogram_quantile.
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const durationsByRoute = new Map(learnerRoutes.map((route) => [route, { buckets: DURATION_BUCKETS.map(() => 0), sum: 0, count: 0 }]));
function recordDuration(route, seconds) {
  let entry = durationsByRoute.get(route);
  if (!entry) {
    entry = { buckets: DURATION_BUCKETS.map(() => 0), sum: 0, count: 0 };
    durationsByRoute.set(route, entry);
  }
  for (let i = 0; i < DURATION_BUCKETS.length; i++) {
    if (seconds <= DURATION_BUCKETS[i]) entry.buckets[i] += 1;
  }
  entry.sum += seconds;
  entry.count += 1;
}

function renderDurations(label) {
  const lines = [];
  for (const [route, entry] of [...durationsByRoute.entries()].sort()) {
    for (let i = 0; i < DURATION_BUCKETS.length; i++) {
      lines.push(`scaling_lab_http_response_duration_seconds_bucket{pod=${label},route="${route}",le="${DURATION_BUCKETS[i]}"} ${entry.buckets[i]}`);
    }
    lines.push(`scaling_lab_http_response_duration_seconds_bucket{pod=${label},route="${route}",le="+Inf"} ${entry.count}`);
    lines.push(`scaling_lab_http_response_duration_seconds_sum{pod=${label},route="${route}"} ${entry.sum}`);
    lines.push(`scaling_lab_http_response_duration_seconds_count{pod=${label},route="${route}"} ${entry.count}`);
  }
  return lines.join('\n');
}

function recordResponse(method, route, status) {
  const key = `${method}|${route}|${status}|${statusClassOf(status)}`;
  responsesByStatus.set(key, (responsesByStatus.get(key) || 0) + 1);
}

function renderResponses(label) {
  const lines = [];
  for (const [key, count] of [...responsesByStatus.entries()].sort()) {
    const [method, route, status, statusClass] = key.split('|');
    lines.push(`scaling_lab_http_responses_total{pod=${label},method="${method}",route="${route}",status="${status}",status_class="${statusClass}"} ${count}`);
  }
  return lines.join('\n');
}

function log(event, fields = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, pod, active, ...fields }));
}
function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Bounded downstream caller (lesson 12: fixed-concurrency dependency).
// Every knob is server-side capped so learner input cannot create unbounded
// retries, waits, or concurrency. Non-finite env values fall back to defaults
// instead of poisoning comparisons (NaN would disable the pool cap).
function finiteNum(raw, fallback, min, max) {
  const v = Number(raw);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}
const depPoolMax = finiteNum(process.env.DEP_POOL, 2, 1, 4);
const depTimeoutMs = finiteNum(process.env.DEP_TIMEOUT_MS, 2000, 250, 5000);
const depRetries = Math.round(finiteNum(process.env.DEP_RETRIES, 0, 0, 3));
const depBackoffMs = finiteNum(process.env.DEP_BACKOFF_MS, 100, 0, 1000);
const upstreamUrl = (process.env.UPSTREAM_URL || '').replace(/\/$/, '');
const allocMaxInflight = 8;
let depInflight = 0;
let depShedTotal = 0;
let allocInflight = 0;

function fetchUpstream(path, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(kill); resolve(r); } };
    const req = http.get(`${upstreamUrl}${path}`, { timeout: timeoutMs }, (res) => {
      const status = res.statusCode;
      res.resume();
      // Success requires a COMPLETE body with no error: 200 headers followed
      // by a reset must not count as a successful dependency call.
      res.on('end', () => done({ status, complete: true, ms: Date.now() - started, depPod: res.headers['x-pod'] || null }));
      res.on('error', (error) => done({ status: null, complete: false, ms: Date.now() - started, error: error.code || error.message }));
    });
    // Absolute deadline: socket inactivity timeouts alone cannot bound a
    // slowly-dribbling upstream response.
    const kill = setTimeout(() => req.destroy(new Error('dep deadline exceeded')), timeoutMs);
    req.on('timeout', () => req.destroy(new Error('dep timeout')));
    req.on('error', (error) => done({ status: null, complete: false, ms: Date.now() - started, error: error.code || error.message }));
  });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const connection = connections.get(req.socket);
  // Local lifecycle hook endpoint for the preStop exec hook. It is not
  // learner traffic: excluded from request counters and metrics.
  if (url.pathname === '/lifecycle' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const phase = (JSON.parse(body || '{}').phase) || 'prestop';
    const waitMs = Math.min(10000, Math.max(0, Number(process.env.PRESTOP_WAIT_MS || 2000)));
    log('prestop-start', { phase, ready, active });
    await new Promise(resolve => setTimeout(resolve, waitMs));
    log('prestop-end', { phase, ready, active });
    return reply(res, 200, { ok: true, phase });
  }
  if (url.pathname === '/health/live') return reply(res, 200, { live: true, pod });
  if (url.pathname === '/health/ready') return reply(res, ready ? 200 : 503, { ready, pod });
  if (url.pathname === '/metrics') {
    const label = JSON.stringify(pod);
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
    const responses = renderResponses(label);
    const durations = renderDurations(label);
    res.end(`# HELP scaling_lab_http_requests_total Application HTTP requests excluding probes and metrics\n# TYPE scaling_lab_http_requests_total counter\nscaling_lab_http_requests_total{pod=${label}} ${requestsTotal}\n# HELP scaling_lab_http_responses_total Completed HTTP responses by bounded method/route/status; excludes probes and lifecycle\n# TYPE scaling_lab_http_responses_total counter\n${responses ? responses + '\n' : ''}# HELP scaling_lab_http_response_duration_seconds Learner response latency by bounded route; excludes probes and lifecycle\n# TYPE scaling_lab_http_response_duration_seconds histogram\n${durations ? durations + '\n' : ''}# HELP scaling_lab_http_inflight_requests Learner requests currently being handled; excludes probes, metrics scrapes, and lifecycle\n# TYPE scaling_lab_http_inflight_requests gauge\nscaling_lab_http_inflight_requests{pod=${label}} ${active}\n# HELP scaling_lab_http_open_sockets Currently open TCP sockets including probes and metrics scrapes\n# TYPE scaling_lab_http_open_sockets gauge\nscaling_lab_http_open_sockets{pod=${label}} ${openSockets}\n# HELP scaling_lab_dep_inflight_requests Calls currently holding a dependency pool slot\n# TYPE scaling_lab_dep_inflight_requests gauge\nscaling_lab_dep_inflight_requests{pod=${label}} ${depInflight}\n# HELP scaling_lab_dep_shed_total Calls rejected without calling upstream because the dependency pool was full\n# TYPE scaling_lab_dep_shed_total counter\nscaling_lab_dep_shed_total{pod=${label}} ${depShedTotal}\n# HELP scaling_lab_alloc_inflight_requests Concurrent /alloc calls currently holding memory\n# TYPE scaling_lab_alloc_inflight_requests gauge\nscaling_lab_alloc_inflight_requests{pod=${label}} ${allocInflight}\n`);
    return;
  }
  requestsTotal++;
  active++;
  const request = req.headers['x-request-id'] || randomUUID();
  const route = routeName(url.pathname);
  const method = methodName(req.method);
  const startedAt = performance.now();
  const finishWith = (status) => {
    try {
      recordResponse(method, route, status);
      recordDuration(route, (performance.now() - startedAt) / 1000);
    } catch { /* metrics never break responses */ }
  };
  res.on('finish', () => finishWith(res.statusCode));
  res.setHeader('x-pod', pod);
  res.setHeader('x-app-connection', String(connection));
  res.setHeader('x-request-id', request);
  res.setHeader('cache-control', 'no-store');
  log('request-start', { request, connection, path: url.pathname });
  res.once('close', () => { active--; log('request-end', { request, connection, complete: res.writableFinished }); });
  if (url.pathname === '/slow') {
    const ms = Math.min(20000, Math.max(0, Number(url.searchParams.get('ms') || 5000)));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.flushHeaders();
    await new Promise(resolve => setTimeout(resolve, ms));
    if (!res.destroyed) res.end(JSON.stringify({ pod, request, connection, ms }));
  } else if (url.pathname === '/cpu') {
    const ms = Math.min(3000, Math.max(0, Number(url.searchParams.get('ms') || 300)));
    const until = performance.now() + ms;
    while (performance.now() < until) Math.sqrt(Math.random());
    reply(res, 200, { pod, request, connection, ms });
  } else if (url.pathname === '/stream') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    let count = 0;
    const timer = setInterval(() => {
      if (res.destroyed || count++ >= 20) { clearInterval(timer); res.end(); }
      else res.write(`${pod} tick ${count}\n`);
    }, 500);
    res.once('close', () => clearInterval(timer));
  } else if (url.pathname === '/alloc') {
    // Bounded memory-pressure probe (lesson 09 OOM demo). Per-request cap
    // keeps one call harmless and total concurrent allocations are capped, so
    // only deliberate concurrent calls against a tight container limit can
    // OOM — which is exactly the demonstrated behavior.
    if (allocInflight >= allocMaxInflight) {
      reply(res, 429, { error: 'too many concurrent allocations', retryable: true });
    } else {
      const mbRaw = Number(url.searchParams.get('mb') ?? 8);
      const holdRaw = Number(url.searchParams.get('holdMs') ?? 500);
      if (!Number.isFinite(mbRaw) || !Number.isFinite(holdRaw)) {
        reply(res, 400, { error: 'mb and holdMs must be finite numbers' });
      } else {
        const mb = Math.min(32, Math.max(1, Math.round(mbRaw)));
        const holdMs = Math.min(2000, Math.max(0, holdRaw));
        allocInflight += 1;
        try {
          const buf = Buffer.alloc(mb * 1024 * 1024);
          for (let i = 0; i < buf.length; i += 4096) buf[i] = 1;
          // The live reference is held through the full interval so RSS
          // really stays elevated; it is released exactly once below.
          await new Promise((resolve) => setTimeout(resolve, holdMs));
          buf[buf.length - 1] = 2;
          if (!res.destroyed) reply(res, 200, { pod, allocatedMb: mb, holdMs });
        } finally {
          allocInflight -= 1;
        }
      }
    }
  } else if (url.pathname === '/dep') {
    if (!upstreamUrl) {
      reply(res, 501, { error: 'no upstream configured (UPSTREAM_URL unset)' });
    } else if (depInflight >= depPoolMax) {
      // Early load shedding: reject instead of queueing unboundedly. Shed
      // load is a 502 with shed:true, counted apart from successful latency.
      depShedTotal += 1;
      reply(res, 502, { error: 'dependency pool exhausted', shed: true, pool: depPoolMax });
    } else {
      const msRaw = Number(url.searchParams.get('ms') ?? 300);
      if (!Number.isFinite(msRaw)) {
        reply(res, 400, { error: 'ms must be a finite number' });
      } else {
        const ms = Math.min(2000, Math.max(0, msRaw));
        const via = url.searchParams.get('via') === 'cpu' ? 'cpu' : 'slow';
        depInflight += 1;
        try {
          let last = null, attempts = 0;
          for (let attempt = 0; attempt <= depRetries; attempt++) {
            if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, depBackoffMs * attempt));
            attempts += 1;
            last = await fetchUpstream(`/${via}?ms=${ms}`, depTimeoutMs);
            if (last.status === 200 && last.complete) break;
          }
          if (res.destroyed) return;
          if (last.status === 200 && last.complete) reply(res, 200, { pod, depPod: last.depPod, ms: last.ms, attempts });
          else if (last.status == null || /timeout|deadline exceeded/i.test(last.error || '')) reply(res, 504, { error: 'dependency timeout', shed: false, depError: last.error || null, attempts });
          else reply(res, 502, { error: 'dependency failed', shed: false, depStatus: last.status, attempts });
        } finally {
          depInflight -= 1;
        }
      }
    }
  } else {
    reply(res, 200, { pod, request, connection, ready, active, mode, keepAliveBudgetMs: server.keepAliveTimeout + (server.keepAliveTimeoutBuffer || 0) });
  }
});
server.keepAliveTimeout = 5000;
server.requestTimeout = 30000;
server.headersTimeout = 31000;
server.on('connection', socket => {
  const id = ++nextConnection;
  connections.set(socket, id);
  openSockets++;
  log('connection-open', { connection: id });
  socket.on('close', () => { openSockets--; log('connection-close', { connection: id }); });
});

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  ready = false;
  log('shutdown-start', { signal, mode, shutdownMs });
  if (mode === 'abrupt') process.exit(1);
  const deadline = setTimeout(() => {
    log('shutdown-deadline');
    server.closeAllConnections();
    process.exit(1);
  }, shutdownMs);
  deadline.unref();
  server.close(() => { clearTimeout(deadline); log('shutdown-complete'); process.exit(0); });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
server.listen(port, '0.0.0.0', () => log('listening', { port, mode }));
