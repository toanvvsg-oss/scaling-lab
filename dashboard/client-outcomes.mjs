// Client completion is independent of the HTTP status received in headers.
// Count recorded terminal events once per request, never request-start events.
export function clientOutcomes(events = []) {
  const starts = new Map();
  const outcomes = new Map();
  for (const [index, event] of events.entries()) {
    const data = event.data || {};
    if (['slow-start', 'stream-start'].includes(event.type)) {
      if (data.requestId) starts.set(data.requestId, data);
      continue;
    }
    if (!['sample', 'request', 'slow-end', 'stream-end'].includes(event.type)) continue;
    const response = { ...starts.get(data.requestId), ...data };
    const status = Number.isInteger(response.status) ? response.status : response.ok === true ? 200 : null;
    const complete = response.complete ?? (!response.error && (response.ok !== false || status !== null));
    outcomes.set(response.requestId || `event:${index}`, {
      status, complete, error: response.error || null, pod: response.pod,
      failed: complete === false || response.ok === false || status >= 400,
    });
  }
  const stats = { total: outcomes.size, completed: 0, failed: 0, ok2xx: 0, http4xx: 0, http5xx: 0, interrupted: 0, transport: 0, recentErrors: [] };
  for (const outcome of outcomes.values()) {
    if (outcome.complete) stats.completed++;
    if (outcome.complete && outcome.status >= 200 && outcome.status < 300) stats.ok2xx++;
    if (outcome.status >= 400 && outcome.status < 500) stats.http4xx++;
    if (outcome.status >= 500 && outcome.status < 600) stats.http5xx++;
    if (outcome.complete === false && outcome.status !== null) stats.interrupted++;
    if (outcome.complete === false && outcome.status === null) stats.transport++;
    if (outcome.failed) {
      stats.failed++;
      stats.recentErrors.push(outcome);
    }
  }
  stats.recentErrors = stats.recentErrors.slice(-5).reverse();
  return stats;
}
