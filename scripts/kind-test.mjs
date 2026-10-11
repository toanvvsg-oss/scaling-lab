import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = new Set(process.argv.slice(2));
const allowed = new Set(['--smoke', '--full', '--fail-after-create', '--hold-after-create']);
if ([...args].some(a => !allowed.has(a))) throw new Error('Unknown kind test option');
const mode = args.has('--smoke') ? 'smoke' : 'full';
const workers = Number(process.env.KIND_TEST_WORKERS ?? 2);
if (![0, 2].includes(workers)) throw new Error('KIND_TEST_WORKERS must be 0 or 2');
const name = 'scaling-lab-test-' + randomUUID().slice(0, 8);
const out = resolve(root, 'results', name);
await mkdir(out, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), name + '-'));
const kubeconfig = join(scratch, 'kubeconfig');
const env = { ...process.env, KUBECONFIG: kubeconfig,
  HELM_CONFIG_HOME: join(scratch, 'helm-config'), HELM_CACHE_HOME: join(scratch, 'helm-cache'),
  HELM_DATA_HOME: join(scratch, 'helm-data'),
  SCALING_LAB_RESULTS_DIR: join(out, 'dashboard') };
const report = { name, mode, workers, pid: process.pid, started: new Date().toISOString(),
  checks: [], phases: [], error: null, signal: null, cleanup: {} };
const abort = new AbortController();
const active = new Set();
let createAttempted = false, backend = null, phase = 'preflight', originals = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
function stopGroup(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  report.signal = signal;
  abort.abort(new Error('Interrupted by ' + signal));
});
const deadline = setTimeout(() => abort.abort(new Error('Full test deadline exceeded (30 minutes)')), 30 * 60_000);
function check(label, pass, detail) {
  report.checks.push({ label, pass: Boolean(pass), detail });
  console.log((pass ? 'PASS ' : 'FAIL ') + label);
  if (!pass) throw new Error(label + ': ' + JSON.stringify(detail));
}
async function command(exe, argv, { cleanup = false, timeout = 600_000 } = {}) {
  if (!cleanup) abort.signal.throwIfAborted();
  const logName = String(report.phases.length).padStart(3, '0') + '-' + exe.replaceAll('/', '-') + '.log';
  const started = Date.now();
  const entry = { phase, command: [exe, ...argv], log: logName };
  report.phases.push(entry);
  console.log('[' + phase + '] ' + exe + ' ' + argv.join(' '));
  let stdout = '', stderr = '', stopped = null;
  const child = spawn(exe, argv, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  active.add(child);
  const halt = reason => { stopped = reason; stopGroup(child); };
  const onAbort = () => halt(abort.signal.reason || new Error('Interrupted'));
  if (!cleanup) abort.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => halt(new Error('Command timeout: ' + exe)), timeout);
  let force;
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  const watchdog = setInterval(() => {
    if (stopped && !force) force = setTimeout(() => stopGroup(child, 'SIGKILL'), 2500);
  }, 200);
  try {
    const code = await new Promise((res, rej) => {
      child.once('error', rej);
      child.once('close', (exitCode, signal) => res(exitCode ?? (signal ? 128 : 1)));
    });
    entry.code = code;
    if (stopped) throw stopped;
    if (code !== 0) throw new Error(exe + ' exited ' + code + ': ' + (stderr || stdout).slice(-2500));
    return stdout;
  } finally {
    clearTimeout(timer); clearTimeout(force); clearInterval(watchdog);
    abort.signal.removeEventListener('abort', onAbort);
    active.delete(child);
    entry.elapsedMs = Date.now() - started;
    await writeFile(join(out, logName), stdout + '\n' + stderr);
  }
}
async function clusters(cleanup = false) {
  return (await command('kind', ['get', 'clusters'], { cleanup, timeout: 30_000 })).trim().split(/\s+/).filter(Boolean);
}
async function freePort() {
  const s = net.createServer();
  await new Promise((r, j) => s.once('error', j).listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise(r => s.close(r));
  return port;
}
async function waitFor(fn, label, timeout = 180_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    abort.signal.throwIfAborted();
    try { if (await fn()) return; } catch (e) { last = e.message; }
    await sleep(700);
  }
  throw new Error('Timeout: ' + label + (last ? ' (' + last + ')' : ''));
}
async function json(url, method = 'GET', body) {
  abort.signal.throwIfAborted();
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12_000)]) });
  const d = await r.json();
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url + ': ' + JSON.stringify(d));
  return d;
}
let base, makeArgs;
const api = (path, method, body) => json(base + path, method, body);
async function createRun(lesson) {
  const r = await api('/api/runs', 'POST', { lesson });
  check('allocated namespace for ' + lesson, /^[a-f0-9]{8}$/.test(r.id) && r.namespace === 'scaling-run-' + r.id, r);
  await waitFor(async () => {
    const state = await api('/api/runs/' + r.id);
    if (state.status === 'failed' || state.status === 'cleanup-failed') throw new Error(state.error);
    return state.status === 'ready';
  }, lesson + ' startup', 240_000);
  return r.id;
}
async function cleanupRun(id) {
  await api('/api/runs/' + id, 'DELETE');
  await waitFor(async () => (await api('/api/runs/' + id)).status === 'deleted', 'namespace cleanup', 120_000);
  const evidence = await api('/api/evidence?run=' + id);
  await writeFile(join(out, 'evidence-' + id + '.json'), JSON.stringify(evidence, null, 2));
  check('archive stays downloadable after cleanup ' + id, evidence.run === id);
}
try {
  originals = await clusters();
  check('fresh cluster name does not exist', !originals.includes(name));
  const edgePort = await freePort();
  const port = await freePort();
  env.SCALING_LAB_EDGE_URL = 'http://127.0.0.1:' + edgePort;
  base = 'http://127.0.0.1:' + port;
  env.PORT = String(port);
  const configPath = join(scratch, 'kind.yaml');
  let config = await readFile(join(root, 'k8s/kind.yaml'), 'utf8');
  config = config.replace('name: scaling-lab', 'name: ' + name).replace('hostPort: 8080', 'hostPort: ' + edgePort);
  if (workers === 0) config = config.replace(/  - role: worker\n    image: [^\n]+\n/g, '');
  await writeFile(configPath, config);
  makeArgs = ['CLUSTER=' + name, 'CTX=kind-scaling-lab', 'KIND_CONFIG=' + configPath, 'EDGE_URL=' + env.SCALING_LAB_EDGE_URL];
  phase = 'create-cluster';
  createAttempted = true;
  await command('kind', ['create', 'cluster', '--name', name, '--config', configPath, '--kubeconfig', kubeconfig, '--wait', '180s'], { timeout: 300_000 });
  await command('kubectl', ['--kubeconfig', kubeconfig, 'config', 'rename-context', 'kind-' + name, 'kind-scaling-lab']);
  await writeFile(join(out, 'started.json'), JSON.stringify({ name, pid: process.pid }, null, 2));
  console.log('CREATED ' + name + ' PID ' + process.pid);
  if (args.has('--fail-after-create')) throw new Error('Intentional failure after cluster creation');
  if (args.has('--hold-after-create')) {
    console.log('HOLD_AFTER_CREATE: send SIGINT/SIGTERM to PID ' + process.pid);
    while (!abort.signal.aborted) await sleep(200);
    abort.signal.throwIfAborted();
  }
  phase = 'production-startup';
  await command('make', ['up', ...makeArgs]);
  check('startup HTTP readiness', (await json(env.SCALING_LAB_EDGE_URL + '/health/ready')).ready === true);
  // A separate process owns all dashboard forwards; kill its whole group
  // before deleting the owned cluster. It reads only the private kubeconfig.
  const fd = openSync(join(out, 'dashboard.log'), 'a');
  backend = spawn(process.execPath, ['dashboard/server.mjs'], { cwd: root, env, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  backend.once('error', e => { report.backendError = e.message; });
  await waitFor(async () => (await api('/api/state')).booted, 'dashboard cold startup');
  check('new cluster has no learner run to adopt', (await api('/api/runs')).length === 0);
  const graf = await api('/api/grafana');
  check('Grafana managed localhost route healthy', graf.available && /^http:\/\/127\.0\.0\.1:\d+$/.test(graf.baseUrl), graf);
  const dash = await json(graf.baseUrl + '/api/dashboards/uid/scaling-lab');
  check('Grafana dashboard provisioned without manual setup', dash.dashboard.uid === 'scaling-lab' && dash.dashboard.panels.some(p => p.id === 7));
  const datasource = await json(graf.baseUrl + '/api/datasources/uid/scaling-prometheus');
  check('Grafana Prometheus datasource provisioned', datasource.type === 'prometheus' && datasource.isDefault);
  phase = 'cli-smoke';
  await command('make', ['verify', 'SCENARIO=connections', ...makeArgs]);
  phase = 'run-isolation-and-http-metrics';
  const a = await createRun('connections');
  const before = await api('/api/runs/' + a + '/cluster');
  const b = await createRun('connections');
  const grafProm = query => json(graf.baseUrl + '/api/datasources/proxy/uid/scaling-prometheus/api/v1/query?query=' + encodeURIComponent(query));
  await waitFor(async () => (await grafProm('min(count_over_time(scaling_lab_http_responses_total{labrun="' + b + '",status="500"}[1m]))')).data.result.some(x => Number(x.value[1]) >= 2), 'status counter scrape baseline');
  for (const action of ['reuse-batch', 'fresh-batch', 'demo-404', 'demo-500']) await api('/api/runs/' + b + '/actions', 'POST', { action });
  const stats = (await api('/api/runs/' + b)).statusStats;
  check('HTTP totals count all requests with actual error codes', stats.total === 18 && stats.byStatus['200'] === 16 && stats.byStatus['404'] === 1 && stats.byStatus['500'] === 1, stats);
  const runGraf = await api('/api/grafana?run=' + b);
  check('Grafana link selects exactly the learner run', new URL(runGraf.runUrl).searchParams.get('var-run') === b);
  const prom = query => json(graf.baseUrl + '/api/datasources/proxy/uid/scaling-prometheus/api/v1/query?query=' + encodeURIComponent(query));
  await waitFor(async () => (await prom('sum(scaling_lab_http_responses_total{labrun="' + b + '",status="500"})')).data.result.some(x => Number(x.value[1]) >= 1), 'actual status metric scrape');
  check('Prometheus sees actual app HTTP 500', true);
  const ratioExpr = dash.dashboard.panels.find(p => p.id === 8).targets[0].expr.replaceAll('$run', b).replaceAll('$__rate_interval', '1m');
  await waitFor(async () => (await prom(ratioExpr)).data.result.some(x => Number(x.value[1]) > 0), 'Grafana HTTP error ratio reacts to demo responses');
  check('Grafana error ratio is measured, not only valid PromQL', true);
  const expressions = dash.dashboard.panels.flatMap(p => (p.targets || []).map(t => t.expr));
  for (const expression of expressions) {
    const query = expression.replaceAll('$run', b).replaceAll('$__rate_interval', '1m');
    check('Grafana PromQL evaluates: ' + expression.slice(0, 90), (await prom(query)).status === 'success');
  }
  await cleanupRun(b);
  check('B startup/load/cleanup leaves A unchanged', JSON.stringify(await api('/api/runs/' + a + '/cluster')) === JSON.stringify(before));
  await cleanupRun(a);
  if (mode === 'full') {
    phase = 'scaler-startup';
    await command('make', ['prometheus-up', ...makeArgs]);
    await command('make', ['hpa-up', ...makeArgs]);
    await waitFor(async () => {
      const raw = await command('kubectl', ['--context', 'kind-scaling-lab', '-n', 'scaling-lab', 'get', 'hpa', 'app', '-o', 'json'], { timeout: 15_000 });
      return JSON.parse(raw).status?.currentMetrics?.some(m => m.resource?.current?.averageUtilization != null);
    }, 'metrics-server supplies CPU values', 180_000);
    const matrix = [
      ['connections'], ['timeouts'], ['shutdown', 'graceful'], ['shutdown', 'abrupt'],
      ['rollout'], ['streaming'], ['autoscale'], ['prometheus'],
    ];
    for (const [lesson, shutdownMode] of matrix) {
      phase = 'lesson-' + lesson + (shutdownMode ? '-' + shutdownMode : '');
      const id = await createRun(lesson);
      await api('/api/runs/' + id + '/run', 'POST', { id: lesson, mode: shutdownMode });
      await waitFor(async () => !(await api('/api/runs/' + id)).scenarioRunning, phase, 420_000);
      const evidence = await api('/api/evidence?run=' + id);
      await writeFile(join(out, phase + '.json'), JSON.stringify(evidence, null, 2));
      check(phase + ' actual verifier passes', evidence.result?.status === 'pass' && evidence.result.checks.every(c => c.pass), evidence.result || evidence.error);
      if (lesson === 'shutdown' && shutdownMode === 'abrupt') {
        check('expected abrupt pass still records interrupted HTTP response', evidence.statusStats?.transport > 0, evidence.statusStats);
      }
      await cleanupRun(id);
    }
  }
} catch (error) {
  report.error = phase + ': ' + error.message;
  console.error('FAIL ' + report.error);
} finally {
  phase = 'cleanup';
  clearTimeout(deadline);
  for (const child of active) stopGroup(child);
  if (backend) {
    stopGroup(backend);
    if (backend.exitCode == null) await Promise.race([new Promise(r => backend.once('exit', r)), sleep(3000)]);
    stopGroup(backend, 'SIGKILL');
  }
  if (createAttempted) {
    if (report.error) {
      await command('kind', ['export', 'logs', '--name', name, join(out, 'kind-logs')], { cleanup: true, timeout: 45_000 }).catch(e => { report.diagnosticsError = e.message; });
    }
    try {
      await command('kind', ['delete', 'cluster', '--name', name, '--kubeconfig', kubeconfig], { cleanup: true, timeout: 120_000 });
      const after = await clusters(true);
      report.cleanup.clusterDeleted = !after.includes(name);
      report.cleanup.originalClustersPreserved = originals.every(c => after.includes(c));
      if (!report.cleanup.clusterDeleted || !report.cleanup.originalClustersPreserved) throw new Error('Cluster cleanup/isolation check failed');
      console.log('CLEANUP PASS: owned cluster removed; original clusters preserved');
    } catch (e) { report.cleanup.error = e.message; }
  }
  await rm(scratch, { recursive: true, force: true }).catch(e => { report.cleanup.tempError = e.message; });
  report.finished = new Date().toISOString();
  report.status = report.error || report.cleanup.error || report.cleanup.tempError ? 'fail' : 'pass';
  await writeFile(join(out, 'summary.json'), JSON.stringify(report, null, 2));
  console.log('Evidence: ' + join(out, 'summary.json'));
  process.exitCode = report.signal === 'SIGINT' ? 130 : report.signal === 'SIGTERM' ? 143 : report.status === 'pass' ? 0 : 1;
}
