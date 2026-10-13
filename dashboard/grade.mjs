export function percentile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((q / 100) * sorted.length) - 1));
  return sorted[i];
}

export function gradeHpaReact({ baseline, series, predictDesired, slowStartup, recovery, scaleOut }) {
  if (!baseline || !Array.isArray(series) || series.length === 0) throw new Error('gradeHpaReact needs a baseline and a non-empty series.');
  const desiredPeak = Math.max(...series.map((s) => s.desired ?? 0));
  // Only burst-phase samples count as HPA scale-out lag: the template-gated
  // rollout stalls readiness by construction and must never substitute for
  // proof of an HPA decision.
  const burstSeries = series.filter((s) => !s.phase || s.phase === 'hpa-scale-out');
  const hpaLag = burstSeries.some((s) => (s.desired ?? 0) > (s.ready ?? 0));
  const gatedRollout = slowStartup?.kind === 'template-gated-rollout' && slowStartup.gapObserved;
  const restored = slowStartup?.restored === true;
  const sawDecision = series.some((s) => (s.desired ?? baseline.desired ?? 2) !== (baseline.desired ?? 2)) || desiredPeak > (baseline.replicas ?? 2);
  const predicted = Number.isFinite(predictDesired) ? predictDesired : null;
  const predictionClose = predicted == null || Math.abs(predicted - desiredPeak) <= 1;
  const evidence = {
    baseline, series, predictDesired: predicted, desiredPeak, slowStartup: slowStartup || null, recovery: recovery || null,
    scaleOut: scaleOut || null,
    formula: 'desiredReplicas = ceil(currentReplicas × observedUtilization / targetUtilization), then tolerance (±10% ignores small moves) applies; missing-metric pods are set aside initially, then included conservatively at the target for scale-down or zero for scale-up; not-yet-ready CPU pods can dampen scale-up. The controller holds if the adjusted ratio reverses direction or falls within tolerance; min/max bounds and scale-down stabilization apply.',
    note: 'Predictions are approximations: when too few pods report a current metric, the HPA skips those pods and may hold the last decision instead of computing from incomplete data. The lab never plots missing observations as measured zero; the HPA algorithm itself uses conservative assumptions when recomputing the ratio.',
  };
  const checks = [
    { pass: baseline.target === 60, label: `Baseline recorded the HPA target (60%) with ${baseline.replicas} replicas, desired ${baseline.desired ?? '?'}` },
    { pass: sawDecision, label: sawDecision ? `HPA desired moved under burst (peak desired ${desiredPeak}); tolerance and missing metrics explain non-moves` : 'HPA desired never moved under burst — check that CPU load reached the pods (see series)' },
    { pass: hpaLag, label: hpaLag ? `HPA scale-out lag in burst phase${scaleOut?.scaleOutLagSec != null ? ` (~${scaleOut.scaleOutLagSec}s from desired bump to Ready catch-up)` : ''}: the decision preceded usable capacity` : 'No HPA-level desired>Ready gap during the burst — scale-out was faster than the 3s sampling or load never scaled' },
    { pass: gatedRollout, label: gatedRollout ? `Template-gated rollout stalled new pods (${slowStartup.unreadySamples}/6 samples unready) while old pods served — readiness-stage lag, distinct from the HPA decision above` : 'Template-gated rollout stall was not demonstrated' },
    { pass: restored, label: restored ? 'Readiness probe restored to its exact original value and rollout settled' : `Probe restore FAILED${slowStartup?.restoreError ? `: ${slowStartup.restoreError}` : ' (unknown state)'} — inspect the deployment before trusting this run` },
    { pass: Boolean(recovery && recovery.samples >= 3), label: recovery?.samples >= 3 ? `Recovery trajectory recorded over ${recovery.samples} samples after load stopped (stabilization delays scale-down ~60s)` : 'Recovery trajectory too short to show stabilization' },
    { pass: predictionClose, label: predicted == null ? 'No numeric prediction was stated before the burst' : Math.abs(predicted - desiredPeak) <= 1 ? `Prediction ${predicted} ≈ observed peak desired ${desiredPeak} (±1 tolerance band)` : `Prediction ${predicted} vs observed peak desired ${desiredPeak}: outside ±1 — name the cause (tolerance, bounds, missing metric, or readiness)` },
  ];
  // Missing-metric honesty: predictions stay approximations, but the run can
  // still pass when every stage has evidence; only absent evidence blocks.
  const required = [checks[0], checks[1], checks[2], checks[3], checks[4], checks[5]];
  return { status: required.every((c) => c.pass) ? 'pass' : 'inconclusive', checks, evidence };
}

export function gradePending({ constrained, restored, events }) {
  const sawPending = (constrained?.pending || 0) > 0;
  const distinguished = constrained && Number.isFinite(constrained.desired) && Number.isFinite(constrained.scheduled)
    && Number.isFinite(constrained.ready) && constrained.desired >= constrained.scheduled;
  const reasoned = Array.isArray(events) && events.some((e) => /FailedScheduling|didn't match|Insufficient|unschedulable/i.test(e.message || e.reason || ''));
  const recovered = (restored?.pending || 0) === 0 && (restored?.ready || 0) >= 2;
  const evidence = {
    constrained: constrained || null, restored: restored || null,
    schedulerEvents: (events || []).slice(0, 10),
    note: 'Desired (deployment spec) vs scheduled (assigned to a node) vs Running vs Ready (passing probes) are four different numbers. HPA can raise desired all day; missing resources need schedulable capacity; impossible placement needs a constraint change. kind never autoscales nodes — the GKE continuation covers node scale-up.',
  };
  const checks = [
    { pass: sawPending, label: sawPending ? `${constrained.pending} pod(s) stayed Pending under the run-scoped constraint` : 'No Pending pods were observed while constrained' },
    { pass: Boolean(distinguished), label: distinguished ? `Counts distinguished: desired ${constrained.desired}, scheduled ${constrained.scheduled}, ready ${constrained.ready}` : 'Replica counts were not fully distinguished' },
    { pass: reasoned, label: reasoned ? 'Scheduler events name the placement failure (no silent Pending)' : 'No scheduler reason captured — Pending without a reason is unexplained' },
    { pass: recovered, label: recovered ? `Constraint removed: ${restored.ready} Ready, ${restored.pending} Pending — the run namespace is schedulable again` : 'Run did not recover to Ready after restore' },
  ];
  return { status: checks.every((c) => c.pass) ? 'pass' : 'inconclusive', checks, evidence };
}

export function gradeCapacity({ steps, config, sloP95Ms, sloErrorPct, plannedRates }) {
  const evidenceNote = 'Capacity is the highest offered rate meeting the stated latency/error objective on this single-pod configuration, counted only over steps where the generator kept up. It is not a production rating: workload, data, neighbors, and ingress all differ, and a clean generator only rules out generator saturation — it never proves the observed limit is solely the service.';
  if (!Array.isArray(steps) || !Array.isArray(plannedRates) || plannedRates.length === 0) {
    throw new Error('gradeCapacity needs steps and a non-empty plannedRates array.');
  }
  if (!Number.isFinite(sloP95Ms) || sloP95Ms < 50 || sloP95Ms > 10000) throw new Error('sloP95Ms must be between 50 and 10000.');
  if (!Number.isFinite(sloErrorPct) || sloErrorPct < 0 || sloErrorPct > 50) throw new Error('sloErrorPct must be between 0 and 50.');
  const num = (v) => Number.isFinite(v) && v >= 0;
  // Settled accounting per step: every offered request is either started or
  // dropped/skipped, and every started request settled as completed or failed
  // (timeouts are a subset of failed, never a third outcome). Generator-health
  // fields (missedSlots, peakInflight, timely, elapsedMs) must be present and
  // numeric so a delayed generator cannot silently claim a sustained rate.
  const settled = (s) => s && num(s.offered) && num(s.started) && num(s.dropped) && num(s.completed)
    && num(s.failed) && num(s.timeouts) && num(s.timely) && num(s.missedSlots) && num(s.peakInflight) && num(s.elapsedMs)
    && s.timeouts <= s.failed && s.timely <= s.completed
    && s.offered === s.started + s.dropped && s.started === s.completed + s.failed;
  const byRate = new Map((steps || []).map((s) => [s?.rate, s]));
  const covered = plannedRates.every((r) => settled(byRate.get(r)));
  const rows = plannedRates.map((r) => byRate.get(r)).filter(settled);
  const enoughSamples = (s) => (s.completed + s.failed) >= Math.max(20, Math.floor(s.offered * 0.5));
  const sampled = rows.length > 0 && rows.every(enoughSamples);
  const kept = rows.filter((s) => s.dropped === 0 && s.missedSlots === 0);
  const verdicts = rows.map((s) => {
    const total = s.completed + s.failed;
    const errPct = total ? (s.failed / total) * 100 : 100;
    const limited = s.dropped > 0 || s.missedSlots > 0;
    return {
      rate: s.rate, generatorLimited: limited,
      meets: !limited && s.p95 != null && s.p95 <= sloP95Ms && errPct <= sloErrorPct,
      p95: s.p95, errPct: Math.round(errPct * 10) / 10,
    };
  });
  // Capacity is withheld unless at least one step is generator-clean: when
  // every step dropped offers, no observed limit can be attributed, so the
  // verdict is indeterminate rather than a capacity number.
  const meeting = verdicts.filter((v) => v.meets).map((v) => v.rate);
  const determinate = covered && sampled && kept.length > 0;
  const capacityRps = determinate && meeting.length ? Math.max(...meeting) : null;
  const evidence = {
    config, slo: { p95Ms: sloP95Ms, errorPct: sloErrorPct },
    plannedRates, steps: rows, verdicts, capacityRps,
    capacityWithheld: determinate ? meeting.length === 0 : true,
    note: evidenceNote,
  };
  const checks = [
    { pass: covered, label: `Sweep covered every planned rate with settled accounting (offered = started + dropped, started = completed + failed) (${rows.length}/${plannedRates.length})` },
    { pass: sampled, label: 'Every covered step recorded enough settled samples (≥20 and ≥50% of offered)' },
    { pass: kept.length > 0, label: kept.length > 0 ? `Generator sustained the offered rate on ${kept.length}/${rows.length} step(s) (no dropped offers, no missed slots); capacity is judged only there` : 'Generator dropped offers or missed slots at every rate: limits observed are generator-limited, capacity withheld' },
    {
      pass: determinate,
      label: !determinate
        ? 'SLO verdict indeterminate: insufficient or generator-limited evidence is inconclusive, not a capacity claim'
        : capacityRps != null
          ? `Highest generator-clean rate meeting p95 ≤ ${sloP95Ms}ms and errors ≤ ${sloErrorPct}%: ${capacityRps} RPS on one pod`
          : `No generator-clean rate met p95 ≤ ${sloP95Ms}ms and errors ≤ ${sloErrorPct}% on one pod — lower the objective or add capacity`,
    },
  ];
  return { status: checks.every((c) => c.pass) ? 'pass' : 'inconclusive', checks, evidence };
}

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

export function gradeResources({ denom, throttle, oom, restored }) {
  const denomShown = denom && Number.isFinite(denom.utilBefore) && Number.isFinite(denom.utilAfter)
    && denom.utilAfter < denom.utilBefore / 2 && denom.trafficSame;
  const throttled = throttle && throttle.samePod === true && Number.isFinite(throttle.baseDeltaUsec) && Number.isFinite(throttle.tightDeltaUsec)
    && throttle.tightDeltaUsec > Math.max(100000, throttle.baseDeltaUsec * 10) && throttle.capped === true;
  const oomProved = oom && oom.restartsAfter > oom.restartsBefore && /OOMKilled/.test(oom.reason || '');
  const evidence = {
    denom: denom || null, throttle: throttle || null, oom: oom || null, restored: restored || null,
    note: 'Requests set the HPA/scheduling denominator; limits cap runtime use (cpu.stat throttled_usec measures throttling directly — latency alone never proves it); memory limits kill with reason OOMKilled.',
  };
  const checks = [
    { pass: Boolean(denomShown), label: denomShown ? `Same traffic read ${denom.utilBefore}% before and ${denom.utilAfter}% after raising the CPU request — the denominator moved, not the work` : 'Denominator effect not shown: utilization did not at least halve at constant traffic' },
    { pass: Boolean(throttled), label: throttled ? `cpu.stat on ${throttle.podTight}: throttled_usec +${throttle.tightDeltaUsec}µs under the 150m limit vs +${throttle.baseDeltaUsec}µs at limit 1 (hottest-pod deltas in each window under pinned traffic, usage ${throttle.tightUsageMs}ms), pod CPU capped ~${throttle.cappedCpuM}m — throttling measured, not inferred` : 'Direct throttling evidence missing (need hottest-pod throttled_usec deltas in both windows plus capped usage under the tight limit)' },
    { pass: Boolean(oomProved), label: oomProved ? `Memory demo: restarts ${oom.restartsBefore}→${oom.restartsAfter} with termination reason OOMKilled` : 'OOM not proved (need a restart plus OOMKilled termination reason)' },
    { pass: restored === true, label: restored === true ? 'Resources restored to the exact pre-experiment originals (request never exceeded limit in any phase)' : 'Resource restore state unclear — inspect the deployment' },
  ];
  return { status: checks.every((c) => c.pass) ? 'pass' : 'inconclusive', checks, evidence };
}

export function gradeSignals({ cpuPhase, ioPhase, rps }) {
  const both = cpuPhase && ioPhase && cpuPhase.offered > 0 && ioPhase.offered > 0;
  // Cost contrast on the hottest pod's burned CPU (instant cgroup counters),
  // not on lagged top averages: keepalive pinning concentrates each phase.
  const cpuCost = both && Number.isFinite(cpuPhase.hotUsageMs) && Number.isFinite(ioPhase.hotUsageMs)
    && ioPhase.hotUsageMs > 0 && cpuPhase.hotUsageMs >= ioPhase.hotUsageMs * 2;
  const ioSlow = both && Number.isFinite(ioPhase.p50) && ioPhase.p50 >= 400 && Number.isFinite(cpuPhase.p50);
  const evidence = {
    rps, cpuPhase: cpuPhase || null, ioPhase: ioPhase || null,
    note: 'Equal offered RPS, different work cost: CPU burn shows in container CPU, slow I/O shows in latency. A signal that cannot see cost (plain RPS) is a poor scaling signal for I/O-bound or queued work.',
  };
  const checks = [
    { pass: Boolean(both), label: both ? `Both phases offered ${rps} RPS with settled samples (CPU ${cpuPhase.completed}, I/O ${ioPhase.completed} completed)` : 'Comparison incomplete: both phases need settled samples' },
    { pass: Boolean(cpuCost), label: cpuCost ? `Same RPS, different cost: hottest pod burned ${cpuPhase.hotUsageMs}ms (CPU work) vs ${ioPhase.hotUsageMs}ms (slow I/O) over equal 20s phases` : 'CPU cost did not separate (need hottest-pod burn ≥2× on the CPU phase)' },
    { pass: Boolean(ioSlow), label: ioSlow ? `I/O latency (p50 ${ioPhase.p50}ms) is invisible to an RPS counter — backlog or in-flight work would see it` : 'I/O latency signal missing (need slow-phase p50 ≥400ms)' },
  ];
  return { status: checks.every((c) => c.pass) ? 'pass' : 'inconclusive', checks, evidence };
}

export const DOWNSTREAM_MIN_OFFERED = 200;

export function gradeDownstream({ phaseS, phaseA, phaseB, depS, depA, depB, settling, restored, restoreError }) {
  const warnings = [];
  const num = (v) => Number.isFinite(v);
  const phaseOk = (p) => p && num(p.offered) && num(p.timelyRps);
  const generatorClean = (p) => phaseOk(p) &&
    ['started', 'dropped', 'completed', 'failed', 'timeouts', 'missedSlots'].every((k) => num(p[k]) && p[k] >= 0) &&
    p.offered === p.started + p.dropped && p.started === p.completed + p.failed &&
    p.timeouts <= p.failed && p.dropped === 0 && p.missedSlots === 0 &&
    p.started >= DOWNSTREAM_MIN_OFFERED;
  const shedRatio = (p) => ((p?.shed || 0) + (p?.timeouts || 0)) / Math.max(1, p?.offered || 0);
  const workloadOf = (p) => p?.workload || null;
  const settingsOf = (p) => p?.settings || null;
  const sameWorkload = (a, b) => {
    const wa = workloadOf(a), wb = workloadOf(b);
    if (!wa || !wb) return false;
    return wa.path === wb.path && wa.rps === wb.rps && wa.durationMs === wb.durationMs;
  };
  const samePolicy = (a, b) => {
    const pa = settingsOf(a)?.policy, pb = settingsOf(b)?.policy;
    if (!pa || !pb) return false;
    return pa.retries === pb.retries && pa.timeoutMs === pb.timeoutMs && pa.backoffMs === pb.backoffMs;
  };
  const sameDepReplicas = (a, b) => Number.isInteger(settingsOf(a)?.depReplicas) &&
    settingsOf(a).depReplicas > 0 && settingsOf(a).depReplicas === settingsOf(b)?.depReplicas;
  const policyLabel = (p) => {
    const pol = settingsOf(p)?.policy;
    if (!pol) return p?.policyLabel || p?.policy || 'unknown policy';
    return `retries=${pol.retries},timeout=${pol.timeoutMs}ms,backoff=${pol.backoffMs}ms`;
  };

  // Scale check (Q4.1): 2-vs-4 callers, same policy/workload/dependency, with
  // actual Ready counts proving the intended caller counts ran.
  let scaleOk = false, scaleLabel = '';
  if (!phaseOk(phaseS) || !phaseOk(phaseA)) {
    scaleLabel = 'Scale comparison missing: need measured 2-caller (S) and 4-caller (A) phases';
  } else {
    const sSet = settingsOf(phaseS), aSet = settingsOf(phaseA);
    const callersOk = sSet?.callersDesired === 2 && aSet?.callersDesired === 4
      && sSet?.callersReady === 2 && aSet?.callersReady === 4;
    const controlled = sameWorkload(phaseS, phaseA) && samePolicy(phaseS, phaseA) && sameDepReplicas(phaseS, phaseA);
    if (!sSet || !aSet) {
      warnings.push('Scale comparison uncontrolled: caller settings not recorded for S/A.');
      scaleLabel = 'Scale comparison uncontrolled: caller settings not recorded (need callersDesired/Ready per phase)';
    } else {
      if (!callersOk) warnings.push(`Scale callers unexpected: S desired/ready ${sSet.callersDesired}/${sSet.callersReady}, A ${aSet.callersDesired}/${aSet.callersReady} (need 2/2 vs 4/4).`);
      if (!sameWorkload(phaseS, phaseA)) warnings.push('Scale comparison uncontrolled: S and A workloads differ (path/rps/duration must match).');
      if (!samePolicy(phaseS, phaseA)) warnings.push('Scale comparison uncontrolled: S and A retry policies differ (only the caller count may move).');
      if (!sameDepReplicas(phaseS, phaseA)) warnings.push('Scale comparison uncontrolled: dependency replica counts differ between S and A.');
      scaleOk = callersOk && controlled && generatorClean(phaseS) && generatorClean(phaseA);
      if (!generatorClean(phaseS) || !generatorClean(phaseA)) warnings.push('Scale comparison needs sufficient generator-clean, settled samples in S and A.');
      scaleLabel = scaleOk
        ? `Scale measured 2→4 callers under the same budget (${policyLabel(phaseS)}), same workload and dependency: timely ${phaseS.timelyRps}→${phaseA.timelyRps}/s (ready ${sSet.callersReady}→${aSet.callersReady})`
        : `Scale comparison indeterminate (need 2 vs 4 callers with identical policy/workload/dependency, matching Ready counts, and sufficient generator-clean settled samples)`;
    }
  }

  // Saturation check: measured on the dependency, never inferred from app
  // shedding alone. App errors cannot establish which component is saturated.
  const depCpu = (d) => (d && num(d.cpuM) ? d.cpuM : null);
  const saturatedIn = (_p, d) => depCpu(d) != null && depCpu(d) >= 800;
  let saturationOk = false, saturationLabel = '';
  if (!phaseOk(phaseS) || !phaseOk(phaseA)) {
    saturationLabel = 'Saturation unknown: S/A phases missing';
  } else {
    saturationOk = saturatedIn(phaseS, depS) || saturatedIn(phaseA, depA);
    const cpuTxt = `dep CPU S~${depCpu(depS) ?? '?'}m/A~${depCpu(depA) ?? '?'}m`;
    saturationLabel = saturationOk
      ? `Bottleneck measured on the dependency (${cpuTxt}; shed+timeouts/offered S ${(shedRatio(phaseS) * 100).toFixed(0)}%, A ${(shedRatio(phaseA) * 100).toFixed(0)}%)`
      : `No bottleneck measured: dependency not saturated in S or A (${cpuTxt}; shed ratios below 20%)`;
  }

  // Retry check (Q4.2): same callers and workload, combined timeout+retry
  // budget change — never attributed to retries alone. A strict budget that
  // performs worse is still a valid measurement, so it passes.
  let retryOk = false, retryLabel = '', retryVerdict = 'retry comparison indeterminate';
  if (!phaseOk(phaseA) || !phaseOk(phaseB)) {
    retryLabel = 'Retry comparison missing: need measured 4-caller phases A and B';
  } else {
    const aSet = settingsOf(phaseA), bSet = settingsOf(phaseB);
    const thin = !generatorClean(phaseA) || !generatorClean(phaseB);
    const attemptsMeasured = [phaseA, phaseB].every((p) =>
      num(p.attemptsAvg) && num(p.attemptsMax) && p.attemptsN >= 10);
    const sameCallers = aSet && bSet && aSet.callersDesired === bSet.callersDesired && aSet.callersReady === bSet.callersReady;
    const controlled = sameCallers && sameWorkload(phaseA, phaseB) && sameDepReplicas(phaseA, phaseB) && !samePolicy(phaseA, phaseB);
    const attemptsLine = `attempts/call ${phaseA.attemptsAvg ?? '?'} (max ${phaseA.attemptsMax ?? '?'}) → ${phaseB.attemptsAvg ?? '?'} (max ${phaseB.attemptsMax ?? '?'})`;
    const budgetLine = `combined budget change (${policyLabel(phaseA)} → ${policyLabel(phaseB)}) at ${aSet?.callersDesired ?? '?'} callers`;
    if (phaseB.timelyRps > phaseA.timelyRps) {
      retryVerdict = `strict budget raised timely success ${phaseA.timelyRps}→${phaseB.timelyRps}/s via ${budgetLine} with ${attemptsLine}`;
    } else if (phaseB.timelyRps < phaseA.timelyRps) {
      retryVerdict = `strict budget lowered timely success ${phaseA.timelyRps}→${phaseB.timelyRps}/s via ${budgetLine} with ${attemptsLine} — failing fast is not always winning, and the numbers say so here`;
    } else {
      retryVerdict = `timely success unchanged (${phaseA.timelyRps}/s) via ${budgetLine} with ${attemptsLine}: the dependency cap dominates both budgets`;
    }
    if (!aSet || !bSet) {
      warnings.push('Retry comparison uncontrolled: caller settings not recorded for A/B.');
      retryLabel = 'Retry comparison uncontrolled: caller settings not recorded (need matching callers per phase)';
    } else {
      if (!sameCallers) warnings.push(`Retry callers differ: A ${aSet.callersDesired}/${aSet.callersReady} vs B ${bSet.callersDesired}/${bSet.callersReady} (must match).`);
      if (!sameWorkload(phaseA, phaseB)) warnings.push('Retry comparison uncontrolled: A and B workloads differ (path/rps/duration must match).');
      if (samePolicy(phaseA, phaseB)) warnings.push('Retry comparison uncontrolled: A and B policies identical (need a combined timeout/retry budget change).');
      if (!sameDepReplicas(phaseA, phaseB)) warnings.push('Retry comparison uncontrolled: dependency replica counts differ between A and B.');
      if (thin) warnings.push(`Generator evidence insufficient: A settled ${(phaseA.completed || 0) + (phaseA.failed || 0)}, B settled ${(phaseB.completed || 0) + (phaseB.failed || 0)}; need ≥${DOWNSTREAM_MIN_OFFERED} per phase, no dropped/missed offers, and settled accounting.`);
      retryOk = controlled && !thin && attemptsMeasured;
      if (!attemptsMeasured) warnings.push('Retry comparison needs measured attempts per call in both phases (at least 10 observations).');
      retryLabel = retryOk ? `Both retry phases generator-clean with separated reject counts — ${retryVerdict}` : `Retry comparison indeterminate (${thin ? `need ≥${DOWNSTREAM_MIN_OFFERED} offered per phase` : 'workload/settings must match except the combined budget'})`;
    }
    if (!retryOk) retryVerdict = 'retry comparison indeterminate; insufficient controlled evidence to attribute a policy outcome';
  }

  // Settling check (Q4.3): bounded waits between phases with residual
  // in-flight work measured at zero. Missing observations do not prove drain.
  let settlingOk = false, settlingLabel = '';
  if (!Array.isArray(settling) || settling.length < 2) {
    settlingLabel = 'Settling missing: need ≥2 bounded waits with residual in-flight captured';
  } else {
    const bounded = settling.filter((s) => s && num(s.waitMs) && s.waitMs > 0 && s.waitMs <= 60000 && s.residualInflight === 0);
    settlingOk = bounded.length >= 2;
    settlingLabel = settlingOk
      ? `Settling captured ${bounded.length} bounded waits (${bounded.map((s) => `${s.label || 'settle'} ${Math.round(s.waitMs / 1000)}s, residual ${s.residualInflight ?? 'unread'}`).join('; ')})`
      : `Settling unproven: ${bounded.length}/≥2 bounded waits ended with measured zero residual work`;
    if (!settlingOk) warnings.push('Settling uncontrolled: record ≥2 bounded waits with the residual dep in-flight gauge read after each.');
  }

  // Restore check: callers back to 2 with the default policy, loudly.
  const restoreOk = restored === true && (restoreError == null || restoreError === '');
  const restoreLabel = restoreOk
    ? 'Callers back to 2 replicas with the default dependency policy'
    : `Caller restore FAILED${restoreError ? `: ${restoreError}` : ' (unknown state)'} — inspect the deployment before trusting this run`;

  const comparison = ['S', 'A', 'B'].map((k) => {
    const p = k === 'S' ? phaseS : k === 'A' ? phaseA : phaseB;
    const d = k === 'S' ? depS : k === 'A' ? depA : depB;
    if (!p) return { phase: k, missing: true };
    const total = (p.completed || 0) + (p.failed || 0);
    return {
      phase: k,
      workload: p.workload || null,
      settings: p.settings || null,
      policyLabel: policyLabel(p),
      durationMs: p.workload?.durationMs ?? p.elapsedMs ?? null,
      offered: p.offered ?? null,
      samples: total,
      timelyRps: p.timelyRps ?? null,
      p95: p.p95 ?? null,
      errorPct: p.errorPct ?? null,
      shed: p.shed ?? null,
      timeouts: p.timeouts ?? null,
      attemptsAvg: p.attemptsAvg ?? null,
      attemptsMax: p.attemptsMax ?? null,
      depCpuM: d?.cpuM ?? p.depCpuM ?? null,
      depInflight: d?.inflight ?? null,
    };
  });
  const verdict = [scaleOk ? `scale: ${phaseS.timelyRps}→${phaseA.timelyRps}/s (2→4 callers)` : 'scale: indeterminate', retryVerdict].join('; ');
  const evidence = {
    phaseS: phaseS || null, phaseA: phaseA || null, phaseB: phaseB || null,
    depS: depS || null, depA: depA || null, depB: depB || null,
    settling: Array.isArray(settling) ? settling : null,
    restored: restored ?? null, restoreError: restoreError || null,
    comparison, warnings, verdict,
    note: 'Rejected/shed traffic is counted apart from successful latency so fast failures cannot fake health. Dependency saturation is measured on the dependency (CPU at limit, inflight gauge), not inferred from app shedding alone. Timeout moves together with retries: verdicts name the combined budget change, never retries alone.',
  };
  const checks = [
    { pass: scaleOk, label: scaleOk ? `Scale comparison controlled — ${scaleLabel}` : scaleLabel },
    { pass: saturationOk, label: saturationLabel },
    { pass: retryOk, label: retryLabel },
    { pass: settlingOk, label: settlingLabel },
    { pass: restoreOk, label: restoreLabel },
  ];
  return { status: checks.every((c) => c.pass) ? 'pass' : 'inconclusive', checks, evidence };
}

export function gradeDisruptions({ evict1, evict2, deleted, traffic, pdbRemoved }) {
  const allowed = evict1 && evict1.allowed === true;
  // Block proof is the API refusal AND/OR the PDB status: disruptionsAllowed
  // 0 means the budget itself reports no room, independent of message text.
  const refused = evict2 && evict2.allowed === false;
  const blocked = refused && (/429|TooManyRequests|Forbidden|disruption budget/i.test(evict2.detail || '') || evict2.pdbAllowed === 0);
  const bypassed = deleted && deleted.deleted === true;
  const sampled = traffic && traffic.total >= 20;
  const evidence = {
    evict1: evict1 || null, evict2: evict2 || null, deleted: deleted || null, traffic: traffic || null, pdbRemoved,
    note: 'Only the eviction API honors PDBs: the first ordered eviction is allowed, the second is blocked (429), and direct deletion bypasses the budget. Background failures cluster around deletes/rollout — reported, not hidden.',
  };
  const checks = [
    { pass: Boolean(allowed), label: allowed ? `Ordered eviction allowed (${evict1.pod}) while the budget had room` : 'No allowed eviction proved' },
    { pass: Boolean(blocked), label: blocked ? `Second ordered eviction refused with budget evidence (${(evict2.detail || '').slice(0, 100)}; PDB disruptionsAllowed=${evict2.pdbAllowed ?? 'unread'})` : 'No blocked eviction proved (need an API refusal plus 429/budget text or PDB disruptionsAllowed=0)' },
    { pass: Boolean(bypassed), label: bypassed ? `Direct deletion of ${deleted.pod} succeeded despite the PDB — budgets do not stop deletes` : 'Delete-bypass not demonstrated' },
    { pass: Boolean(sampled), label: sampled ? `Background traffic sampled ${traffic.total} requests (${traffic.failures} failures, all categorized)` : 'Background traffic too thin to judge (<20 samples)' },
    { pass: pdbRemoved === true, label: pdbRemoved === true ? 'PDB removed after the exercise' : 'PDB cleanup state unclear' },
  ];
  return { status: checks.every((c) => c.pass) ? 'pass' : 'inconclusive', checks, evidence };
}

export function gradeGateway({ drain, analogue }) {
  const timed = drain && drain.podDeleteAt && drain.endpointGoneAt && drain.requestEndAt;
  const ordered = timed && drain.ordering;
  const categorized = drain && drain.bg && (drain.bg.ok + drain.bg.http502 + drain.bg.transport) > 0;
  const evidence = {
    drain: drain || null,
    analogue: analogue || 'local backend-drain analogue: kind has no GKE Gateway/NEGs; endpoint-slice removal stands in for NEG removal. Cloud execution pending configuration.',
    note: 'The verdict reports the recorded order of endpoint removal vs response completion for this single drain — one ordered observation, not a universal claim about 502/503 causes.',
  };
  const checks = [
    { pass: Boolean(timed), label: timed ? `Drain timed: pod deleted, endpoints updated, request ended (all three timestamps recorded)` : 'Drain timing incomplete (need pod-delete, endpoint-gone, and request-end timestamps)' },
    { pass: Boolean(ordered), label: ordered ? `Recorded order: ${drain.ordering}` : 'No ordering verdict recorded' },
    { pass: Boolean(categorized), label: categorized ? `Background outcomes categorized: ${drain.bg.ok} ok, ${drain.bg.http502} HTTP 502/503/504, ${drain.bg.transport} transport failures (rejected kept apart from success)` : 'Background traffic uncategorized' },
  ];
  return { status: checks.every((c) => c.pass) ? 'pass' : 'inconclusive', checks, evidence };
}

export function gradeCapstone({ objective, phases }) {
  const names = ['burst', 'rollout', 'disruption', 'recovery'];
  const complete = names.every((n) => phases?.[n] && Number.isFinite(phases[n].p95) && Number.isFinite(phases[n].errorPct) && phases[n].samples >= 10)
    && phases?.disruption?.eviction === 'allowed';
  const verdicts = complete ? Object.fromEntries(names.map((n) => {
    const p = phases[n];
    const holds = p.p95 <= objective.sloP95Ms && p.errorPct <= objective.sloErrorPct;
    return [n, { holds, p95: p.p95, errorPct: p.errorPct, samples: p.samples }];
  })) : {};
  const heldAll = complete && names.every((n) => verdicts[n].holds);
  const evidence = {
    objective, phases: phases || null, verdicts,
    criteria: `pass requires every phase to meet p95 ≤ ${objective?.sloP95Ms}ms and errors ≤ ${objective?.sloErrorPct}% with ≥10 samples; replica growth alone never passes.`,
    limitations: 'Single mix, laptop-sized rates, one cluster shape. Rerun with production traffic, data, and ingress before trusting any setting.',
  };
  const checks = [
    { pass: Boolean(complete), label: complete ? 'All four phases recorded p95, error rate, and ≥10 samples against the stated objective, with an allowed guarded disruption' : 'Capstone incomplete: every phase needs p95, error rate, and ≥10 samples, and the disruption phase needs an allowed eviction' },
    ...names.map((n) => ({
      pass: Boolean(complete && verdicts[n].holds),
      label: !complete ? `${n}: no verdict (incomplete)` : verdicts[n].holds ? `${n} held: p95 ${verdicts[n].p95}ms, errors ${verdicts[n].errorPct}%` : `${n} BREACHED: p95 ${verdicts[n].p95}ms, errors ${verdicts[n].errorPct}% vs objective`,
    })),
  ];
  return { status: !complete ? 'inconclusive' : heldAll ? 'pass' : 'fail', checks, evidence };
}
