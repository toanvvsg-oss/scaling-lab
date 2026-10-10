import http from 'node:http';
import { randomUUID } from 'node:crypto';

const port = Number(process.env.PORT || 3000);
const pod = process.env.HOSTNAME || 'local';
const mode = process.env.SHUTDOWN_MODE || 'graceful';
const shutdownMs = Number(process.env.SHUTDOWN_MS || 24000);
let ready = true;
let active = 0;
let requestsTotal = 0;
let nextConnection = 0;
const connections = new WeakMap();

function log(event, fields = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, pod, active, ...fields }));
}
function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
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
    res.end(`# HELP scaling_lab_http_requests_total Application HTTP requests excluding probes and metrics\n# TYPE scaling_lab_http_requests_total counter\nscaling_lab_http_requests_total{pod=${label}} ${requestsTotal}\n# HELP scaling_lab_http_inflight_requests Requests currently being handled\n# TYPE scaling_lab_http_inflight_requests gauge\nscaling_lab_http_inflight_requests{pod=${label}} ${active}\n`);
    return;
  }
  requestsTotal++;
  active++;
  const request = req.headers['x-request-id'] || randomUUID();
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
  log('connection-open', { connection: id });
  socket.on('close', () => log('connection-close', { connection: id }));
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
