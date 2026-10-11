import http from 'node:http';

const ROUTES = new Set(['/fast', '/slow', '/stream', '/metrics', '/health/ready', '/health/live']);
const RESPONSE_HEADERS = ['content-type', 'x-pod', 'x-app-connection', 'x-request-id', 'x-edge-connection'];

// Only known learner endpoints on the run's existing, server-owned route.
// No client-supplied hosts, ports, upstream URLs, credentials, or shell commands.
export function learnerPath(path, params) {
  const target = path || '/fast';
  if (!ROUTES.has(target)) throw Object.assign(new Error('Unknown app endpoint.'), { status: 404 });
  if ([...params.keys()].some((key) => target !== '/slow' || key !== 'ms')) {
    throw Object.assign(new Error('Only the slow endpoint accepts a query parameter (ms).'), { status: 400 });
  }
  if (params.has('ms')) {
    const values = params.getAll('ms');
    if (values.length !== 1 || !/^\d+$/.test(values[0]) || Number(values[0]) > 20000) {
      throw Object.assign(new Error('ms must be an integer between 0 and 20000.'), { status: 400 });
    }
    return `${target}?ms=${Number(values[0])}`;
  }
  return target;
}

export function proxyRunApp(req, res, run, path) {
  const upstream = http.request({
    hostname: '127.0.0.1', port: run.forwardPort, path, method: req.method,
    headers: { accept: req.headers.accept || '*/*' },
  }, (response) => {
    const headers = { 'cache-control': 'no-store', 'x-scaling-lab-run': run.id, 'x-scaling-lab-namespace': run.ns };
    for (const name of RESPONSE_HEADERS) if (response.headers[name]) headers[name] = response.headers[name];
    res.writeHead(response.statusCode, headers);
    res.flushHeaders();
    response.on('error', () => res.destroy());
    response.on('aborted', () => res.destroy());
    response.pipe(res);
  });
  upstream.setTimeout(45000, () => upstream.destroy(new Error('App request timed out.')));
  upstream.on('error', () => {
    if (res.destroyed) return;
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'The run app is temporarily unavailable. Check its Ready pods and try again.' }));
  });
  res.on('close', () => upstream.destroy());
  upstream.end();
}
