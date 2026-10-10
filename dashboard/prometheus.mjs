import { spawn } from 'node:child_process';

export const LEGACY_RATE_QUERY = 'sum(rate(scaling_lab_http_requests_total{job="scaling-app",namespace="scaling-lab"}[30s]))';
export const SCRAPE_TARGET = 5;

export function rateQueryForRun(runId) {
  if (!/^[a-z0-9]{8}$/.test(runId)) throw new Error(`Invalid run id: ${runId}`);
  return `sum(rate(scaling_lab_http_requests_total{job="scaling-app",labrun="${runId}"}[30s]))`;
}

export function upQueryForRun(runId) {
  if (!/^[a-z0-9]{8}$/.test(runId)) throw new Error(`Invalid run id: ${runId}`);
  return `count(up{job="scaling-app",labrun="${runId}"} == 1)`;
}

let forward = null;
let port = null;

export async function prometheusPort() {
  if (forward && port) return port;
  const child = spawn('kubectl', ['--context', 'kind-scaling-lab', '-n', 'scaling-lab', 'port-forward', '--address', '127.0.0.1', 'service/prometheus', ':9090'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const found = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Prometheus port-forward did not start')); }, 12000);
    let output = '';
    const inspect = (chunk) => {
      output += chunk.toString();
      const m = output.match(/Forwarding from 127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timeout); resolve(Number(m[1])); }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.on('error', (e) => { clearTimeout(timeout); reject(e); });
    child.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`Prometheus port-forward exited ${code}`)); });
  }).catch((e) => { try { child.kill(); } catch { /* ignore */ } forward = null; port = null; throw e; });
  forward = child;
  port = found;
  child.on('exit', () => { forward = null; port = null; });
  return port;
}

// True stored-sample freshness for one run's counter series.
// timestamp(v) returns each sample's ACTUAL stored timestamp as the result
// VALUE (Prometheus docs, query functions). query_range step times would only
// be evaluation times, so we do not use them here. Returns the freshest and
// stalest per-pod sample times plus whether every target scraped OK (up==1).
// A failed scrape (up != 1) or samples older than 3 scrape intervals is stale
// and must never display as a fresh zero.
export async function queryRunSamples(counterSel, upSel) {
  const empty = { total: null, at: null, stalestAt: null, upAllOne: false, evaluatedAt: null, stale: true };
  try {
    const p = await prometheusPort();
    const instant = async (q) => {
      const response = await fetch(`http://127.0.0.1:${p}/api/v1/query?query=${encodeURIComponent(q)}&time=${Math.floor(Date.now() / 1000)}`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return null;
      const data = await response.json();
      return data.status === 'success' ? data : null;
    };
    const [totalRes, tsRes, upRes] = await Promise.all([
      instant(`sum(${counterSel})`),
      instant(`timestamp(${counterSel})`),
      instant(upSel),
    ]);
    if (!totalRes || !tsRes || !upRes) return empty;
    const evaluatedAt = new Date().toISOString();
    const totalSample = totalRes.data?.result?.[0]?.value;
    const stamps = (tsRes.data?.result || []).map((r) => Number(r.value?.[1])).filter(Number.isFinite);
    const ups = (upRes.data?.result || []).map((r) => Number(r.value?.[1]));
    if (!stamps.length || !ups.length) return { ...empty, evaluatedAt };
    const freshest = Math.max(...stamps);
    const stalest = Math.min(...stamps);
    const upAllOne = ups.every((v) => v === 1);
    const ageMs = Date.now() - freshest * 1000;
    const stale = !upAllOne || ageMs > 15000;
    return {
      total: totalSample ? Number(totalSample[1]) : null,
      at: new Date(freshest * 1000).toISOString(),
      stalestAt: new Date(stalest * 1000).toISOString(),
      upAllOne, evaluatedAt, stale,
    };
  } catch { return empty; }
}

export function counterSelForRun(runId) {
  if (!/^[a-z0-9]{8}$/.test(runId)) throw new Error(`Invalid run id: ${runId}`);
  return `scaling_lab_http_requests_total{job="scaling-app",labrun="${runId}"}`;
}

// Completed-response selectors by bounded status class. The app exposes
// scaling_lab_http_responses_total{method,route,status,status_class}; the
// legacy requests_total stays the KEDA/autoscale denominator.
export function responsesSelForRun(runId, statusClass) {
  if (!/^[a-z0-9]{8}$/.test(runId)) throw new Error(`Invalid run id: ${runId}`);
  if (!['2xx', '4xx', '5xx'].includes(statusClass)) throw new Error(`Invalid status class: ${statusClass}`);
  return `scaling_lab_http_responses_total{job="scaling-app",labrun="${runId}",status_class="${statusClass}"}`;
}

export function responsesRateQueryForRun(runId, statusClass) {
  return `sum(rate(${responsesSelForRun(runId, statusClass)}[1m]))`;
}

export function counterQueryForRun(runId) {
  return `sum(${counterSelForRun(runId)})`;
}

export function upSelForRun(runId) {
  if (!/^[a-z0-9]{8}$/.test(runId)) throw new Error(`Invalid run id: ${runId}`);
  return `up{job="scaling-app",labrun="${runId}"}`;
}

// Instant-query evaluation result: `at` is evaluation time, not scrape time.
export async function queryPrometheus(query) {
  try {
    const p = await prometheusPort();
    const response = await fetch(`http://127.0.0.1:${p}/api/v1/query?query=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { value: null, at: null, stale: true };
    const data = await response.json();
    if (data.status !== 'success') return { value: null, at: null, stale: true };
    const sample = data.data?.result?.[0]?.value;
    if (sample == null) return { value: null, at: null, stale: true };
    return { value: Number(sample[1]), at: new Date(Number(sample[0]) * 1000).toISOString(), stale: false };
  } catch { return { value: null, at: null, stale: true }; }
}
