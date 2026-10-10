// Client-observed HTTP status vs transport classification.
// The dashboard observes responses through the edge proxy, so this module
// classifies what the *client* saw: a completed HTTP response (2xx, 3xx
// redirect, 4xx, 5xx) or a transport failure (reset/timeout/socket hang
// up). Transport results keep status null and never invent an HTTP status
// — but a partial response that sent headers (e.g. 200) and then reset
// preserves the headers-seen status separately as observedStatus, so
// diagnostics never falsely claim "no HTTP status was observed".
// App-emitted 5xx carries an x-pod header; upstream/proxy-observed 502/504
// usually lacks one. /metrics cannot see proxy errors, so the dashboard is
// the source of truth for edge failures. Hints name possible causes only;
// they never assert a proven root cause.
//
// Error-rate semantics: error% uses 4xx+5xx over counted client responses.
// 3xx redirects are retained separately (never errors) and transport is
// reported as its own clearly-labelled ratio, so 301/304 never inflate the
// error rate. Verifier `ok` semantics (HTTP 200 only) are unchanged: the
// lab scenarios intentionally expect 200.
//
// Accounting rule: every client response emits exactly one 'http-result'
// event carrying the full result object. Trace sampling ('sample' for a
// subset of successes, 'request' for failures, slow-end/stream-end markers)
// is render only and is never folded into totals, so 100 successes with
// 1-in-10 trace sampling still counts total 101. The scenario-completion
// 'result' marker ({status: pass|fail|...}) is a different event type and
// is never counted as HTTP traffic.

export function statusClassOf(status) {
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  return 'other';
}

function kindOf(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 300 && status < 400) return 'redirect';
  return 'http-error';
}

function toStatus(v) {
  if (Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
}

export function classifyResult(r = {}) {
  const status = toStatus(r.status);
  const hasStatus = status != null && Number.isFinite(status);
  const observedStatus = toStatus(r.observedStatus);
  const headersSeen = r.headersSeen === true || r.partial === true || observedStatus != null;
  const hasPod = Boolean(r.pod);

  // Completed HTTP response: finished with a status code. 3xx is its own
  // retained class (redirect), never an error and never transport.
  if (r.complete === true && hasStatus) {
    return {
      kind: kindOf(status),
      status, statusClass: statusClassOf(status),
      transport: null, hasPod, headersSeen: false, observedStatus: null, partial: false,
    };
  }
  // Completed non-2xx without an explicit complete flag (robustness for
  // result objects built from {ok:false, status}): still a completed
  // HTTP response, never transport.
  if (r.ok === false && hasStatus && r.complete !== false && r.error == null) {
    return {
      kind: kindOf(status),
      status, statusClass: statusClassOf(status),
      transport: null, hasPod, headersSeen: false, observedStatus: null, partial: false,
    };
  }
  // Incomplete / failed response: transport. Preserve headers-seen identity
  // (status + pod + requestId observed before the reset) separately from
  // completed counters.
  const transport = typeof r.error === 'string' && r.error ? r.error : 'transport-error';
  return {
    kind: 'transport', status: null, statusClass: null, transport, hasPod,
    headersSeen, observedStatus: observedStatus ?? (headersSeen && hasStatus ? status : null),
    partial: headersSeen,
  };
}

// Short diagnostic hint linked to the observed sample. It names the most
// likely lab cause for the status/transport code but does not claim a root
// cause: the learner must compare the failed sample's pod/requestId,
// Ready endpoints, and pod signals.
export function hintFor(c, r = {}) {
  if (c.kind === 'ok') return 'Completed 2xx response.';
  if (c.kind === 'redirect') return `Completed ${c.status} redirect (not an error; lab verifiers still expect 200). Check the request route for req ${r.requestId || 'unknown'} — the client did not follow the redirect.`;
  if (c.kind === 'http-error') {
    if (c.status === 404) return 'App returned 404 for a predefined demo route. Check the request path/action; transport resets would show no status instead.';
    if (c.status === 500 && c.hasPod) return 'App-emitted 500 (demo-error route carries x-pod). Compare with upstream/proxy-observed 502/504, which the app never sees.';
    if (c.status === 502 || c.status === 504) return `Upstream/proxy-observed ${c.status} from the edge (not proven to be any single cause). Possible: no Ready endpoint when the request arrived, an upstream connect/read timeout, or a pod restarting mid-request. Inspect this sample's pod presence (app-emitted errors carry x-pod; proxy failures usually lack one), req ${r.requestId || 'unknown'}, Ready endpoints, and pod signals before concluding.`;
    if (c.statusClass === '4xx') return `Client-observed ${c.status}: app completed the response with a 4xx. Check the request route/action for req ${r.requestId || 'unknown'}.`;
    return `Client-observed ${c.status}: completed HTTP error response. See pod ${r.pod || 'unknown'} req ${r.requestId || 'unknown'} and Ready endpoints before concluding.`;
  }
  const t = String(c.transport || '');
  const identity = `${c.observedStatus != null ? `HTTP ${c.observedStatus}` : 'no status'}${r.pod || c.hasPod ? `, pod ${r.pod || 'known'}` : ''}${r.requestId ? `, req ${r.requestId}` : ''}`;
  const seen = c.observedStatus != null
    ? ` Headers were seen (${identity}) before the connection broke, so this is an interrupted response, not a refused one.`
    : ' No HTTP status was observed.';
  if (/ECONNRESET|socket hang up|RESET/i.test(t)) return `Connection reset before the response completed (abrupt shutdown or pod delete mid-response?). Check pod signals for the serving pod.${seen}`;
  if (/ETIMEDOUT|timeout/i.test(t)) {
    if (c.observedStatus != null) return `Request timed out after headers (${identity}) were seen: the response did not finish. Check offered load vs Ready pods, slow-path duration vs timeouts, and pod signals.`;
    return `Request timed out with no response. Check offered load vs Ready pods and the edge route.${seen}`;
  }
  if (/ECONNREFUSED/i.test(t)) return `Connection refused: no Ready endpoint accepted the socket. Check Ready endpoints and the edge route.${seen}`;
  return `Transport failure (${t || 'no response'}): incomplete response, counted separately from completed HTTP statuses. Check pod signals and Ready endpoints; do not read this as an app status code.${seen}`;
}

export function emptyStats() {
  return { total: 0, ok2xx: 0, http3xx: 0, http4xx: 0, http5xx: 0, httpOther: 0, transport: 0, partial: 0, byStatus: {}, recentErrors: [] };
}

// Fold one client-observed 'http-result' into cumulative stats. Call exactly
// once per response. Returns the entry.
export function recordStatus(stats, r, at) {
  const c = classifyResult(r);
  stats.total += 1;
  const entry = {
    at: at || new Date().toISOString(),
    kind: c.kind, status: c.status, statusClass: c.statusClass,
    transport: c.transport, pod: r.pod || null, requestId: r.requestId || null,
    ms: typeof r.ms === 'number' ? r.ms : null,
    headersSeen: Boolean(c.headersSeen), observedStatus: c.observedStatus ?? null,
    hint: hintFor(c, r),
  };
  if (c.kind === 'ok') {
    stats.ok2xx += 1;
    stats.byStatus[String(c.status)] = (stats.byStatus[String(c.status)] || 0) + 1;
  } else if (c.kind === 'redirect') {
    // Retained separately: a redirect is a completed response but never an
    // error, so it stays out of recentErrors and the error rate.
    stats.http3xx += 1;
    stats.byStatus[String(c.status)] = (stats.byStatus[String(c.status)] || 0) + 1;
  } else if (c.kind === 'http-error') {
    if (c.statusClass === '4xx') stats.http4xx += 1;
    else if (c.statusClass === '5xx') stats.http5xx += 1;
    else stats.httpOther += 1;
    stats.byStatus[String(c.status)] = (stats.byStatus[String(c.status)] || 0) + 1;
    stats.recentErrors.unshift(entry);
  } else {
    stats.transport += 1;
    if (c.partial) stats.partial += 1;
    const key = `transport:${String(c.transport || 'error').slice(0, 40)}`;
    stats.byStatus[key] = (stats.byStatus[key] || 0) + 1;
    stats.recentErrors.unshift(entry);
  }
  if (stats.recentErrors.length > 10) stats.recentErrors.length = 10;
  return entry;
}

export function summarizeStats(stats) {
  const total = stats.total || 0;
  // error% is 4xx+5xx only: redirects are retained separately and transport
  // is reported as its own clearly-labelled ratio.
  const errors = (stats.http4xx || 0) + (stats.http5xx || 0);
  const transport = stats.transport || 0;
  return {
    total, ok2xx: stats.ok2xx || 0, http3xx: stats.http3xx || 0,
    http4xx: stats.http4xx || 0, http5xx: stats.http5xx || 0, transport,
    errors, errorRate: total ? errors / total : null,
    transportRate: total ? transport / total : null,
  };
}
