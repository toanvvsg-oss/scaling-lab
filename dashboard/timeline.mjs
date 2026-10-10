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
    currentCPU: point.currentCPU ?? null,
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
