export function gradeConnections(reused, fresh) {
  const stable = reused.length >= 6 && new Set(reused).size === 1;
  const separate = fresh.length >= 6 && new Set(fresh).size === fresh.length;
  return {
    status: reused.length < 6 || fresh.length < 6 ? 'inconclusive' : stable && separate ? 'pass' : 'fail',
    checks: [
      { pass: stable, label: 'One client connection served the keep-alive requests' },
      { pass: separate, label: 'A new client connection served each non-reused request' }
    ],
    evidence: { reused, fresh }
  };
}

export function gradeTimeout(shortGap, longGap) {
  const valid = shortGap.length === 2 && longGap.length === 2 && [...shortGap, ...longGap].every(x => x?.ok && x.edgeConnection && x.appConnection);
  const clientReused = valid && shortGap[0].edgeConnection === shortGap[1].edgeConnection && longGap[0].edgeConnection === longGap[1].edgeConnection;
  const upstreamReused = valid && shortGap[0].pod === shortGap[1].pod && shortGap[0].appConnection === shortGap[1].appConnection;
  const upstreamExpired = valid && (longGap[0].pod !== longGap[1].pod || longGap[0].appConnection !== longGap[1].appConnection);
  return {
    status: !valid ? 'inconclusive' : clientReused && upstreamReused && upstreamExpired ? 'pass' : 'fail',
    checks: [
      { pass: clientReused, label: 'The client-to-edge connection survived both idle gaps' },
      { pass: upstreamReused, label: 'The Node.js connection survived the short idle gap' },
      { pass: upstreamExpired, label: 'The Node.js connection expired during the long idle gap' }
    ],
    evidence: { shortGap, longGap }
  };
}

export function gradeShutdown({ slow, samples, deletedPod, mode }) {
  const targeted = Boolean(deletedPod && slow?.pod === deletedPod);
  const completed = slow?.complete === true;
  const errors = samples.filter(x => !x.ok);
  const status = !targeted || samples.length < 20 ? 'inconclusive'
    : mode === 'abrupt' ? (!completed ? 'pass' : 'fail')
    : completed && errors.length === 0 ? 'pass' : 'fail';
  return {
    status,
    checks: [
      { pass: targeted, label: 'The pod serving the long request was deleted' },
      { pass: mode === 'abrupt' ? !completed : completed, label: mode === 'abrupt' ? 'Abrupt exit interrupted the long request' : 'The long request completed' },
      { pass: errors.length === 0, label: 'Background requests had no failures' }
    ],
    evidence: { deletedPod, slow, totalRequests: samples.length, failures: errors.slice(0, 10) }
  };
}

export function gradeRollout(samples, before, after) {
  const podsChanged = before.length && after.some(x => !before.includes(x));
  const errors = samples.filter(x => !x.ok);
  return {
    status: samples.length < 20 || !podsChanged ? 'inconclusive' : errors.length ? 'fail' : 'pass',
    checks: [
      { pass: Boolean(podsChanged), label: 'A new application pod served traffic' },
      { pass: errors.length === 0, label: 'No sampled request failed during the rollout' }
    ],
    evidence: { before, after, totalRequests: samples.length, failures: errors.slice(0, 10) }
  };
}

export function gradeStream({ stream, deletedPod }) {
  const targeted = stream?.pod === deletedPod;
  const ticks = (stream?.body || '').trim().split('\n').filter(Boolean).length;
  return {
    status: !targeted ? 'inconclusive' : stream.complete && ticks === 20 ? 'pass' : 'fail',
    checks: [
      { pass: targeted, label: 'The streaming pod was deleted while the response was active' },
      { pass: stream?.complete, label: 'The stream finished without a connection reset' },
      { pass: ticks === 20, label: 'All 20 stream ticks reached the client' }
    ],
    evidence: { deletedPod, complete: stream?.complete, ticks, error: stream?.error, durationMs: stream?.ms }
  };
}

export function gradeAutoscale({ initial, peak, final, stableDown, samples, drainSamples }) {
  const load = samples || [];
  const drain = drainSamples || [];
  const grew = peak > initial;
  // The stableDown flag alone is not enough: the replica count must actually
  // equal the starting count, or a stale/foreign flag could fake a pass.
  const shrank = grew && stableDown === true && final === initial;
  const drainClean = drain.length > 0 && drain.every(x => x.ok);
  const observed = load.length > 0 && drain.length > 0;
  const checks = [
    { pass: grew, label: 'HPA added replicas during CPU load' },
    { pass: shrank, label: 'HPA returned to the starting replica count after load ended' },
    { pass: drainClean, label: 'Sampled requests succeeded during scale down' }
  ];
  return {
    status: !observed ? 'inconclusive' : checks.every(x => x.pass) ? 'pass' : 'fail',
    checks,
    evidence: { initial, peak, final, stableDown, loadRequests: load.length, loadFailures: load.filter(x => !x.ok).length, drainRequests: drain.length, drainFailures: drain.filter(x => !x.ok).slice(0, 10) }
  };
}

export function gradePrometheus({ scrapeTargets, peakRps, peak, initial, final, stableDown, load, drain, query, thresholdRpsPerPod }) {
  const loadArr = load || [];
  const drainArr = drain || [];
  const checks = [
    { pass: scrapeTargets >= 2, label: 'Prometheus scraped both starting app pods' },
    { pass: peakRps > 10, label: 'PromQL observed request demand above the 5 req/s per-pod target' },
    { pass: peak > initial, label: 'KEDA and HPA added app replicas under request load' },
    { pass: stableDown === true && final === initial, label: 'Replicas returned to baseline after the request rate fell' },
    { pass: drainArr.length > 0 && drainArr.every(x => x.ok), label: 'Sampled requests succeeded during scale down' }
  ];
  const observed = loadArr.length > 0 && drainArr.length > 0;
  return {
    status: !observed ? 'inconclusive' : checks.every(x => x.pass) ? 'pass' : 'fail',
    checks,
    evidence: { query, thresholdRpsPerPod: thresholdRpsPerPod ?? 5, scrapeTargets, initial, peak, final, stableDown, peakRps, loadRequests: loadArr.length, loadFailures: loadArr.filter(x => !x.ok).length, drainRequests: drainArr.length, drainFailures: drainArr.filter(x => !x.ok).slice(0, 10) }
  };
}
