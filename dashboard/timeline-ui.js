const rateBox = document.getElementById('prometheus-rate');
const timelineBox = document.getElementById('timeline-chart');
const detailBox = document.getElementById('timeline-detail');
let replayTimer = null;
let replaying = false;

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function series(points, key, max) {
  return points.map((p, i) => {
    const x = 8 + (i * 264) / Math.max(1, points.length - 1);
    const v = p[key];
    const y = v == null ? null : 78 - (Math.min(v, max) * 68) / max;
    return { x, y, v };
  });
}

// Split into contiguous runs so stale/missing samples break the line
// instead of being connected through as if the value were known.
function runs(pts) {
  const out = [];
  let cur = [];
  for (const p of pts) {
    if (p.y == null) { if (cur.length) out.push(cur); cur = []; }
    else cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

function polyline(pts, color, dashed = false, width = 2.5) {
  return runs(pts).map((r) => {
    if (r.length === 1) return `<circle cx="${r[0].x.toFixed(1)}" cy="${r[0].y.toFixed(1)}" r="2" fill="${color}"/>`;
    const str = r.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    return `<polyline points="${str}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${dashed ? ' stroke-dasharray="4 3"' : ''}/>`;
  }).join('');
}

function chartSvg(points) {
  const maxRps = Math.max(15, ...points.map((p) => Math.max(p.offeredRps || 0, p.observedRps || 0, p.offeredTarget || 0)));
  const maxRep = Math.max(5, ...points.map((p) => Math.max(p.desired || 0, p.actual || 0, p.ready || 0)));
  const n = Math.max(1, points.length - 1);
  const rep = (key) => points.map((p, i) => ({ x: 8 + (i * 264) / n, y: p[key] == null ? null : 78 - (Math.min(p[key], maxRep) * 68) / maxRep, v: p[key] }));
  return `<svg class="rate-chart timeline-chart" viewBox="0 0 280 90" role="img" aria-label="Synchronized cause-effect timeline">`
    + `<line x1="8" y1="78" x2="272" y2="78" stroke="#cbd8ca"/>`
    + `<text x="10" y="12" font-size="7" fill="#8a6fb1">req/s (left)</text>`
    + `<text x="272" y="12" font-size="7" fill="#3a7ca5" text-anchor="end">pods (right)</text>`
    + polyline(series(points, 'offeredRps', maxRps), '#8a6fb1')
    + polyline(series(points, 'offeredTarget', maxRps), '#b9a8d6', true, 1.5)
    + polyline(series(points, 'observedRps', maxRps), '#4a8452')
    + polyline(rep('desired'), '#c07a2a', true)
    + polyline(rep('ready'), '#3a7ca5')
    + `</svg>`;
}

function legendHtml() {
  return `<div class="timeline-legend"><span><i style="background:#8a6fb1"></i>offered RPS (measured)</span><span><i style="background:#b9a8d6"></i>target RPS</span><span><i style="background:#4a8452"></i>Prometheus RPS</span><span><i style="background:#c07a2a"></i>HPA desired (pods axis)</span><span><i style="background:#3a7ca5"></i>ready pods (pods axis)</span></div>`;
}

function bindMarks(timeline) {
  const milestones = (timeline.milestones || []).slice(-12);
  const marks = timelineBox.querySelectorAll('.timeline-mark');
  marks.forEach((b) => {
    b.onclick = () => {
      const m = timeline.milestones[Number(b.dataset.mark)];
      if (m && detailBox) detailBox.innerHTML = `<strong>${esc(m.kind)} · ${esc(new Date(m.at).toLocaleTimeString())}</strong><p>${esc(m.text)}</p><p class="timeline-why">Observer: ${esc(m.observer || '—')}. ${esc(m.detail || '')}</p>`;
    };
  });
  return milestones;
}

function marksHtml(timeline) {
  const milestones = (timeline.milestones || []).slice(-12);
  return `<div class="timeline-marks">${milestones.map((m, i) => `<button class="timeline-mark" data-mark="${timeline.milestones.length - milestones.length + i}">${esc(new Date(m.at).toLocaleTimeString())} · ${esc(m.kind)}</button>`).join('')}</div>`;
}

async function update() {
  try {
    const [timeline, appState] = await Promise.all([
      fetch('/api/timeline').then((r) => r.json()),
      fetch('/api/state').then((r) => r.json()).catch(() => ({})),
    ]);
    const scaling = appState.load?.active || appState.running || appState.resetting || appState.scenario === 'prometheus' || appState.scenario === 'autoscale';
    const points = (timeline.points || []).slice(-120);
    if (!scaling || !points.length) {
      rateBox.innerHTML = '<span class="timeline-empty">Switch to lesson 06/07, start manual load, or run the experiment to observe.</span>';
      if (timelineBox && !replaying) timelineBox.innerHTML = '';
      return;
    }
    const latest = points.at(-1);
    const stale = latest.stale || latest.observedRps == null;
    const rateText = stale ? 'stale — no fresh Prometheus sample (not zero)' : `${Number(latest.observedRps).toFixed(1)} requests / second`;
    const hpaText = latest.desired == null ? 'desired ?' : `desired ${latest.desired}`;
    rateBox.innerHTML = `<strong>${esc(rateText)}</strong><span class="timeline-meta">offered ${latest.offeredRps ?? 0} req/s (target ${latest.offeredTarget ?? 0}) · ${esc(hpaText)} · actual ${latest.actual ?? '?'} · ready ${latest.ready ?? '?'} · target 5 req/s per pod</span>`;

    if (timelineBox && !replaying) {
      timelineBox.innerHTML = chartSvg(points) + legendHtml() + marksHtml(timeline);
      bindMarks(timeline);
    }
  } catch { rateBox.textContent = 'Metric unavailable'; }
}

if (document.getElementById('timeline-replay')) {
  document.getElementById('timeline-replay').onclick = async () => {
    clearInterval(replayTimer);
    const timeline = await fetch('/api/timeline').then((r) => r.json());
    const points = timeline.points || [];
    if (!points.length || !timelineBox) return;
    replaying = true;
    let i = 0;
    replayTimer = setInterval(() => {
      i += 1;
      if (i >= points.length) {
        clearInterval(replayTimer);
        replaying = false;
        update();
        return;
      }
      const slice = points.slice(0, i + 1);
      timelineBox.innerHTML = chartSvg(slice) + legendHtml()
        + `<div class="timeline-marks"><span class="timeline-empty">Replaying ${i + 1}/${points.length} at reduced speed — live updates paused, raw evidence stays downloadable.</span></div>`;
    }, 300);
  };
}

if (document.getElementById('evidence-download')) {
  document.getElementById('evidence-download').onclick = async () => {
    const data = await fetch('/api/evidence').then((r) => r.json());
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `scaling-lab-evidence-${Date.now()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
}

update();
setInterval(update, 5000);
