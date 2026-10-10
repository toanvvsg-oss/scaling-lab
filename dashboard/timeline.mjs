export const MAX_POINTS = 720;

export function createHistory() {
  return { points: [], milestones: [] };
}

export function pushPoint(history, point) {
  history.points.push({
    at: point.at || new Date().toISOString(),
    observedAt: point.observedAt || null,
    offeredRps: point.offeredRps ?? null,
    offeredTarget: point.offeredTarget ?? null,
    achievedRps: point.achievedRps ?? null,
    observedRps: 'observedRps' in point ? point.observedRps : null,
    counterTotal: point.counterTotal ?? null,
    sampleAt: point.sampleAt || null,
    scrapeTargets: point.scrapeTargets ?? null,
    scrapeOk: point.scrapeOk ?? null,
    desired: point.desired ?? null,
    actual: point.actual ?? null,
    ready: point.ready ?? null,
    terminating: point.terminating ?? null,
    endpoints: point.endpoints ?? null,
    podsSnapshot: point.podsSnapshot ?? null,
    endpointsSnapshot: point.endpointsSnapshot ?? null,
    currentCPU: point.currentCPU ?? null,
    cpuTarget: point.cpuTarget ?? null,
    externalCurrent: point.externalCurrent ?? null,
    externalRaw: point.externalRaw ?? null,
    externalTarget: point.externalTarget ?? null,
    externalName: point.externalName ?? null,
    stale: Boolean(point.stale),
  });
  if (history.points.length > MAX_POINTS) history.points.splice(0, history.points.length - MAX_POINTS);
}

export function pushMilestone(history, milestone) {
  history.milestones.push({
    at: milestone.at || new Date().toISOString(),
    kind: milestone.kind,
    text: milestone.text,
    detail: milestone.detail || '',
    observer: milestone.observer || '',
  });
  if (history.milestones.length > 300) history.milestones.shift();
}

export function replaySlice(history, speed = 1) {
  return { points: history.points, milestones: history.milestones, speed };
}

// Index of the last point at or before timestamp t (for scrub-to-time).
export function cursorAt(points, t) {
  let idx = -1;
  for (let i = 0; i < points.length; i++) {
    if (new Date(points[i].at).getTime() <= t) idx = i;
    else break;
  }
  return idx;
}


// Events at or before cursor time t (for scrubbing the trace/event views).
export function filterByTime(events, upto) {
  if (upto == null) return events;
  return events.filter((e) => new Date(e.at).getTime() <= upto);
}

// Milestones at or before cursor time (for replay/scrub).
export function marksUpTo(timeline, upto) {
  const marks = (timeline.milestones || []).filter((m) => !upto || new Date(m.at).getTime() <= upto);
  return marks.slice(-12);
}

function fmtElapsedMs(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60)}`;
}

// Measured cause-effect delays from the actual points, not a fixed story.
export function deriveExplanation(points, lesson) {
  if (points.length < 3) return '';
  const t0 = new Date(points[0].at).getTime();
  const first = (pred) => points.find(pred);
  if (lesson === 'autoscale') {
    const load = first((p) => (p.offeredRps || 0) > 1);
    const hot = first((p) => (p.currentCPU || 0) > 60);
    const want = first((p) => (p.desired || 0) > 2);
    const pods = first((p) => (p.ready || 0) > 2);
    const lag = (a, b) => (a && b ? Math.max(0, Math.round(((new Date(b.at) - new Date(a.at)) / 1000))) : null);
    const parts = [];
    if (load) parts.push(`CPU load started at +${fmtElapsedMs(new Date(load.at).getTime() - t0)}`);
    const s1 = lag(load, hot);
    if (s1 != null) parts.push(`CPU crossed 60% ~${s1}s later (metrics-server sampling)`);
    const s2 = lag(hot || load, want);
    if (s2 != null) parts.push(`desired replicas followed ~${s2}s later`);
    const s3 = lag(want || hot || load, pods);
    if (s3 != null) parts.push(`Ready pods arrived ~${s3}s later`);
    if (!parts.length) return 'No CPU movement yet. Apply CPU load and watch CPU % cross the 60% target before desired replicas move.';
    return 'Measured in this run: ' + parts.join('; ') + '. Scale-in waits through the 60s stabilization window.';
  }
  if (lesson !== 'prometheus') {
    const podChanges = points.filter((p, i) => i > 0 && p.actual !== points[i - 1].actual).length;
    const ep = points.at(-1)?.endpoints;
    const guides = {
      connections: 'Compare edge connection IDs across the two batches in the trace: one shared ID means reuse, distinct IDs mean fresh sockets.',
      timeouts: 'Compare short-gap and long-gap upstream connection IDs: the ~6s Node budget expires only across the long gap.',
      shutdown: 'Follow pod terminating → preStop → SIGTERM → response completion in the trace; graceful finishes, abrupt interrupts.',
      rollout: 'Watch actual pods turn over while sampled requests keep succeeding; readiness gates each replacement.',
      streaming: 'Count the 20 ticks in the trace; graceful shutdown lets the active stream finish them all.',
    };
    const facts = [];
    if (podChanges) facts.push(`replica count changed ${podChanges} time(s)`);
    if (ep != null) facts.push(`${ep} ready endpoints at last sample`);
    return (facts.length ? 'Measured in this run: ' + facts.join('; ') + '. ' : '') + (guides[lesson] || 'Inspect the trace for request IDs, connections, and pod signals.');
  }
  const rise = first((p) => (p.offeredRps || 0) > 2);
  const seen = first((p) => (p.observedRps || 0) > 2);
  const want = first((p) => (p.desired || 0) > 2);
  const pods = first((p) => (p.ready || 0) > 2);
  const lag = (a, b) => (a && b ? Math.max(0, Math.round(((new Date(b.at) - new Date(a.at)) / 1000))) : null);
  const parts = [];
  if (rise) parts.push(`offered traffic rose at +${fmtElapsedMs(new Date(rise.at).getTime() - t0)}`);
  const s1 = lag(rise, seen);
  if (s1 != null) parts.push(`scraped RPS followed ~${s1}s later (5s scrape + 30s rate window)`);
  const s2 = lag(seen || rise, want);
  if (s2 != null) parts.push(`desired replicas followed ~${s2}s later (KEDA poll + HPA sync)`);
  const s3 = lag(want || seen || rise, pods);
  if (s3 != null) parts.push(`Ready pods arrived ~${s3}s later (scheduling + readiness)`);
  if (!parts.length) return lesson === 'autoscale'
    ? 'No scaling movement yet. Apply CPU load and watch CPU % cross the 60% target before desired replicas move.'
    : 'No traffic yet. Start a profile and watch offered → scraped → desired → Ready in that order.';
  return 'Measured in this run: ' + parts.join('; ') + '. Scale-in reverses the order through the 60s stabilization window.';
}
