import { spawn as defaultSpawn } from 'node:child_process';

// Managed local-only route to the provisioned Grafana service. The dashboard
// server keeps one kubectl port-forward to svc/grafana (127.0.0.1, ephemeral
// port) while it runs; the UI links/embeds that fixed service only. There is
// deliberately no generic proxy endpoint: arbitrary targets are never
// forwarded.
//
// Lifecycle rules: concurrent startups share one pending child
// (single-flight); closing kills ONLY this module's tracked children;
// a stale child's exit never clears a newer forward.

export const GRAFANA_DASHBOARD_UID = 'scaling-lab';
export const GRAFANA_STATUS_PANEL_ID = 7;

const route = { forward: null, port: null, pending: null };

export function dashboardUrl(baseUrl, runId) {
  const base = String(baseUrl).replace(/\/$/, '');
  const params = new URLSearchParams({ orgId: '1' });
  if (runId != null) {
    if (!/^[a-z0-9]{8}$/.test(runId)) throw new Error(`Invalid run id: ${runId}`);
    params.set('var-run', runId);
  }
  return `${base}/d/${GRAFANA_DASHBOARD_UID}/scaling-lab?${params}`;
}

// Embeddable single-panel view for the observation sidebar (panel 7:
// completed app responses by HTTP code). kiosk mode hides nav; the panel
// query stays run-scoped server-side.
export function panelEmbedUrl(baseUrl, runId, panelId = GRAFANA_STATUS_PANEL_ID) {
  const base = String(baseUrl).replace(/\/$/, '');
  if (!/^[a-z0-9]{8}$/.test(runId)) throw new Error(`Invalid run id: ${runId}`);
  if (!Number.isInteger(panelId) || panelId <= 0) throw new Error(`Invalid panel id: ${panelId}`);
  const params = new URLSearchParams({ orgId: '1', 'var-run': runId, kiosk: '', theme: 'light' });
  return `${base}/d-solo/${GRAFANA_DASHBOARD_UID}/scaling-lab?${params}&panelId=${panelId}`;
}

// Closes ONLY this module's tracked forward/pending child. Never touches
// any other process, cluster, or namespace.
export function closeGrafanaForward() {
  const pending = route.pending;
  route.pending = null;
  if (pending && !pending.settled) {
    pending.settled = true;
    try { if (pending.child) pending.child.kill(); } catch { /* ignore */ }
    pending.reject(new Error('Grafana port-forward closed'));
  }
  const fwd = route.forward;
  route.forward = null;
  route.port = null;
  try { if (fwd) fwd.kill(); } catch { /* ignore */ }
}

function settleAttempt(attempt, outcome) {
  // A superseded attempt (close or a newer startup replaced it) settles
  // nobody: its late exit must not clear a newer forward or port.
  if (attempt.settled || route.pending !== attempt) return false;
  attempt.settled = true;
  route.pending = null;
  if (outcome.port != null) {
    route.forward = attempt.child;
    route.port = outcome.port;
    attempt.resolve(outcome.port);
  } else {
    attempt.reject(outcome.error);
  }
  return true;
}

export function grafanaPort(spawnImpl = defaultSpawn) {
  if (route.forward && route.port) return Promise.resolve(route.port);
  if (route.pending) return route.pending.promise;
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  const attempt = { promise, resolve, reject, child: null, settled: false };
  route.pending = attempt;
  try {
    attempt.child = spawnImpl('kubectl', ['--context', 'kind-scaling-lab', '-n', 'scaling-lab', 'port-forward', '--address', '127.0.0.1', 'service/grafana', ':3000'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    settleAttempt(attempt, { error });
    return promise;
  }
  watchAttempt(attempt);
  return promise;
}

function watchAttempt(attempt) {
  const child = attempt.child;
  let output = '';
  const timer = setTimeout(() => {
    try { child.kill(); } catch { /* ignore */ }
    settleAttempt(attempt, { error: new Error('Grafana port-forward did not start') });
  }, 12000);
  const inspect = (chunk) => {
    output += chunk.toString();
    const m = output.match(/Forwarding from 127\.0\.0\.1:(\d+)/);
    if (m) {
      clearTimeout(timer);
      settleAttempt(attempt, { port: Number(m[1]) });
    }
  };
  child.stdout.on('data', inspect);
  child.stderr.on('data', inspect);
  child.on('error', (error) => {
    clearTimeout(timer);
    settleAttempt(attempt, { error });
  });
  child.on('exit', (code) => {
    clearTimeout(timer);
    // A stale child's exit never clears a newer forward: only clear when
    // the exiting child is still the established one.
    if (route.forward === child) {
      route.forward = null;
      route.port = null;
    }
    settleAttempt(attempt, { error: new Error(`Grafana port-forward exited ${code}: ${output}`) });
  });
}

// Liveness of the managed Grafana route: /api/health on the forwarded port.
// Returns {available, baseUrl} and never throws, so the UI can render a
// "monitoring not installed" state instead of failing.
export async function grafanaStatus(spawnImpl = defaultSpawn) {
  try {
    const p = await grafanaPort(spawnImpl);
    const response = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { available: false, baseUrl: null };
    await response.json();
    return { available: true, baseUrl: `http://127.0.0.1:${p}` };
  } catch {
    return { available: false, baseUrl: null };
  }
}
