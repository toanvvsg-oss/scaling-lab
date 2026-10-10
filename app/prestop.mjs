// preStop hook: notifies the local app so it logs structured prestop-start
// (with live readiness/active counts) and prestop-end around the drain wait.
// Runs as `node /app/prestop.mjs` — no shell quoting involved.
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(new Error('lifecycle call timed out')), 9000);
try {
  const res = await fetch('http://127.0.0.1:3000/lifecycle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phase: 'preStop' }),
    signal: controller.signal,
  });
  if (!res.ok) throw new Error(`lifecycle endpoint returned HTTP ${res.status}`);
} finally {
  clearTimeout(timeout);
}
