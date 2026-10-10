const rateBox = document.getElementById('prometheus-rate');
const timelineBox = document.getElementById('timeline-chart');
const detailBox = document.getElementById('timeline-detail');
let replayTimer = null;

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function series(points, key, max) {
  return points.map((p, i) => {
    const x = 8 + (i * 264) / Math.max(1, points.length - 1);
    const v = p[key];
    const y = v == null ? null : 78 - (Math.min(v, max) * 68) / max;
    return { x, y, v };
  });
}

function polyline(pts, color, dashed = false) {
  const defined = pts.filter((p) => p.y != null);
  if (defined.length < 2) return '';
  const str = defined.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  return `<polyline points="${str}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"${dashed ? ' stroke-dasharray="4 3"' : ''}/>`;
}

async function update() {
  try {
    const [timeline, clusterState] = await Promise.all([
      fetch('/api/timeline').then((r) => r.json()),
      fetch('/api/cluster').then((r) => r.json()).catch(() => ({})),
    ]);
    const points = (timeline.points || []).slice(-120);
    if (!points.length) {
      rateBox.innerHTML = '<span class="timeline-empty">Run lesson 07 or start manual load to observe.</span>';
      if (timelineBox) timelineBox.innerHTML = '';
      return;
    }
    const latest = points.at(-1);
    const stale = latest.stale || latest.observedRps == null;
    const rateText = stale ? 'stale — no fresh Prometheus sample (not zero)' : `${Number(latest.observedRps).toFixed(1)} requests / second`;
    const hpaText = latest.desired == null ? 'desired ?' : `desired ${latest.desired}`;
    rateBox.innerHTML = `<strong>${esc(rateText)}</strong><span class="timeline-meta">offered ${latest.offeredRps ?? 0} req/s · ${esc(hpaText)} · actual ${latest.actual ?? '?'} · ready ${latest.ready ?? '?'} · target 5 req/s per pod</span>`;

    if (timelineBox) {
      const maxRps = Math.max(15, ...points.map((p) => Math.max(p.offeredRps || 0, p.observedRps || 0)));
      const maxRep = Math.max(5, ...points.map((p) => Math.max(p.desired || 0, p.actual || 0, p.ready || 0)));
      const offered = series(points, 'offeredRps', maxRps);
      const observed = series(points, 'observedRps', maxRps);
      const desired = points.map((p, i) => ({ x: 8 + (i * 264) / Math.max(1, points.length - 1), y: p.desired == null ? null : 78 - (Math.min(p.desired, maxRep) * 68) / maxRep, v: p.desired }));
      const ready = points.map((p, i) => ({ x: 8 + (i * 264) / Math.max(1, points.length - 1), y: p.ready == null ? null : 78 - (Math.min(p.ready, maxRep) * 68) / maxRep, v: p.ready }));
      const milestones = (timeline.milestones || []).slice(-12);
      timelineBox.innerHTML = `<svg class="rate-chart timeline-chart" viewBox="0 0 280 90" role="img" aria-label="Synchronized cause-effect timeline">`
        + `<line x1="8" y1="78" x2="272" y2="78" stroke="#cbd8ca"/>`
        + polyline(offered, '#8a6fb1') + polyline(observed, '#4a8452') + polyline(desired, '#c07a2a', true) + polyline(ready, '#3a7ca5')
        + `</svg>`
        + `<div class="timeline-legend"><span><i style="background:#8a6fb1"></i>offered RPS</span><span><i style="background:#4a8452"></i>Prometheus RPS</span><span><i style="background:#c07a2a"></i>HPA desired</span><span><i style="background:#3a7ca5"></i>ready pods</span></div>`
        + `<div class="timeline-marks">${milestones.map((m, i) => `<button class="timeline-mark" data-mark="${timeline.milestones.length - milestones.length + i}">${esc(new Date(m.at).toLocaleTimeString())} · ${esc(m.kind)}</button>`).join('')}</div>`;
      timelineBox.querySelectorAll('.timeline-mark').forEach((b) => {
        b.onclick = () => {
          const m = timeline.milestones[Number(b.dataset.mark)];
          if (m && detailBox) detailBox.innerHTML = `<strong>${esc(m.kind)} · ${esc(new Date(m.at).toLocaleTimeString())}</strong><p>${esc(m.text)}</p><p class="timeline-why">Observer: ${esc(m.observer || '—')}. ${esc(m.detail || '')}</p>`;
        };
      });
    }
  } catch { rateBox.textContent = 'Metric unavailable'; }
}

if (document.getElementById('timeline-replay')) {
  document.getElementById('timeline-replay').onclick = async () => {
    clearInterval(replayTimer);
    const timeline = await fetch('/api/timeline').then((r) => r.json());
    const points = timeline.points || [];
    if (!points.length || !timelineBox) return;
    let i = 0;
    replayTimer = setInterval(() => {
      i += 1;
      if (i >= points.length) { clearInterval(replayTimer); return; }
      const slice = points.slice(0, i + 1);
      const maxRps = Math.max(15, ...slice.map((p) => Math.max(p.offeredRps || 0, p.observedRps || 0)));
      timelineBox.querySelector('svg').innerHTML = `<line x1="8" y1="78" x2="272" y2="78" stroke="#cbd8ca"/>` + polyline(series(slice, 'offeredRps', maxRps), '#8a6fb1') + polyline(series(slice, 'observedRps', maxRps), '#4a8452');
      if (detailBox) detailBox.textContent = `Replaying ${i + 1}/${points.length} at reduced speed — raw evidence stays downloadable.`;
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
