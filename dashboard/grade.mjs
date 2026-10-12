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
    formula: 'desiredReplicas = ceil(currentReplicas × observedUtilization / targetUtilization), then tolerance (±10% ignores small moves) applies; unready or metric-less pods are left out of the calculation (controller holds rather than guessing); min/max bounds and scale-down stabilization apply.',
    note: 'Predictions are approximations: when too few pods report a current metric, the HPA skips those pods and may hold the last decision instead of computing from incomplete data. Missing metrics are never treated as zero.',
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
    note: 'Desired (deployment spec) vs scheduled (assigned to a node) vs Running vs Ready (passing probes) are four different numbers. HPA can raise desired all day; only schedulable node capacity clears Pending. kind never autoscales nodes — the GKE continuation covers node scale-up.',
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
    { pass: Boolean(throttled), label: throttled ? `cpu.stat on ${throttle.podTight}: throttled_usec +${throttle.tightDeltaUsec}µs under the 150m limit vs +${throttle.baseDeltaUsec}µs at limit 1 (same pod pinned, usage ${throttle.tightUsageMs}ms), pod CPU capped ~${throttle.cappedCpuM}m — throttling measured, not inferred` : 'Direct throttling evidence missing (need a same-pod throttled_usec jump plus capped usage under the tight limit)' },
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

export function gradeDownstream({ phaseA, phaseB, depA, depB, restored }) {
  const measured = phaseA && phaseB && depA && depB && Number.isFinite(depA.cpuM) && Number.isFinite(depB.cpuM);
  const bottleneck = measured && (depA.cpuM >= 800 || (phaseA.shed + phaseA.timeouts) / Math.max(1, phaseA.offered) > 0.2);
  const determinate = measured && phaseA.offered >= 200 && phaseB.offered >= 200;
  const attemptsLine = `attempts/call ${phaseA.attemptsAvg ?? '?'} (max ${phaseA.attemptsMax ?? '?'}) → ${phaseB.attemptsAvg ?? '?'} (max ${phaseB.attemptsMax ?? '?'})`;
  const verdict = determinate ? (phaseB.timelyRps > phaseA.timelyRps ? `strict policy raised timely success ${phaseA.timelyRps}→${phaseB.timelyRps}/s with ${attemptsLine}` : phaseB.timelyRps < phaseA.timelyRps ? `strict policy lowered timely success ${phaseA.timelyRps}→${phaseB.timelyRps}/s with ${attemptsLine} — failing fast is not always winning, and the numbers say so here` : `timely success unchanged (${phaseA.timelyRps}/s) with ${attemptsLine}: the dependency cap dominates both policies`) : 'comparison indeterminate';
  const evidence = {
    phaseA: phaseA || null, phaseB: phaseB || null, depA: depA || null, depB: depB || null,
    restored: restored || null, verdict,
    note: 'Rejected/shed traffic is counted apart from successful latency so fast failures cannot fake health. Dependency saturation is measured on the dependency (CPU at limit, inflight gauge), not inferred from app shedding alone.',
  };
  const checks = [
    { pass: Boolean(bottleneck), label: bottleneck ? `Bottleneck measured on the dependency (CPU ~${depA.cpuM}m, shed ${phaseA.shed}, timeouts ${phaseA.timeouts} at ${phaseA.offered} offered)` : 'No bottleneck measured: dependency was not saturated in phase A' },
    { pass: Boolean(determinate), label: determinate ? `Both phases generator-clean with separated reject counts — ${verdict}` : 'Retry comparison indeterminate (need ≥200 offered per phase plus dep-side measurement)' },
    { pass: restored === true, label: restored === true ? 'Callers back to 2 replicas with the default dependency policy' : 'Caller restore state unclear — inspect the deployment' },
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
