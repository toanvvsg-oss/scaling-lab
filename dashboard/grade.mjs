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
