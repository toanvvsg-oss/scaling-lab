import { marksUpTo, deriveExplanation } from './timeline.mjs';
const rateBox = document.getElementById('prometheus-rate');
const timelineBox = document.getElementById('timeline-chart');
const detailBox = document.getElementById('timeline-detail');
const explainBox = document.getElementById('timeline-explain');
const pauseBtn = document.getElementById('timeline-pause');
const scrubInput = document.getElementById('timeline-scrub');
const cursorLabel = document.getElementById('timeline-cursor');
let replayTimer = null;
let paused = false;
let cursor = -1; // -1 = live tail
let frozenKey = null;

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function fmtClock(iso) { try { return new Date(iso).toLocaleTimeString(); } catch { return '?'; } }

function series(points, t0, key, max, top = 78) {
  return points.map((p) => {
    const x = 8 + ((new Date(p.at).getTime() - t0) / Math.max(1, elapsedOf(points)) * 264);
    const v = p[key];
    const y = v == null ? null : top - (Math.min(v, max) * 68) / max;
    return { x, y, v };
  });
}
function elapsedOf(points) {
  if (points.length < 2) return 1;
  return Math.max(1, new Date(points.at(-1).at).getTime() - new Date(points[0].at).getTime());
}

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

function axisTicks(max, side) {
  let out = '';
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4;
    const y = 78 - (68 * i) / 4;
    const label = v >= 10 ? String(Math.round(v)) : v.toFixed(1);
    out += `<line x1="8" y1="${y}" x2="272" y2="${y}" stroke="#e6ece3" stroke-width="0.5"/>`
      + (side === 'left'
        ? `<text x="9" y="${y - 1}" font-size="6" fill="#95a69a">${label}</text>`
        : `<text x="272" y="${y - 1}" font-size="6" fill="#95a69a" text-anchor="end">${label}</text>`);
  }
  return out;
}

function chartSvg(points, lesson) {
  const t0 = new Date(points[0].at).getTime();
  const cpu = lesson === 'autoscale';
  const prom = lesson === 'prometheus';
  const maxRps = Math.max(15, ...points.map((p) => Math.max(p.offeredRps || 0, p.observedRps || 0, p.offeredTarget || 0, p.achievedRps || 0)));
  const maxRep = Math.max(5, ...points.map((p) => Math.max(p.desired || 0, p.actual || 0, p.ready || 0, p.terminating || 0, p.endpoints || 0)));
  const maxCpu = Math.max(100, ...points.map((p) => p.currentCPU || 0));
  // CPU lessons use a 0-100 percent left axis; request-rate lines keep their
  // shape for comparison and the legend says so.
  const leftMax = cpu ? maxCpu : maxRps;
  const rps = (key) => series(points, t0, key, leftMax);
  const rep = (key) => series(points, t0, key, maxRep);
  const el = elapsedOf(points);
  const xLabel = (frac) => `<text x="${8 + frac * 264}" y="88" font-size="6" fill="#95a69a" text-anchor="middle">${fmtElapsed(frac * el)}</text>`;
  let svg = `<svg class="rate-chart timeline-chart" viewBox="0 0 280 92" role="img" aria-label="Synchronized cause-effect timeline">`
    + axisTicks(leftMax, 'left') + axisTicks(maxRep, 'right')
    + `<line x1="8" y1="78" x2="272" y2="78" stroke="#cbd8ca"/>`
    + `<text x="10" y="12" font-size="7" fill="#8a6fb1">${cpu ? '% / req/s (left)' : 'req/s (left)'}</text>`
    + `<text x="272" y="12" font-size="7" fill="#3a7ca5" text-anchor="end">pods (right)</text>`
    + xLabel(0) + xLabel(0.5) + xLabel(1)
    + polyline(rps('offeredRps'), '#8a6fb1')
    + polyline(rps('offeredTarget'), '#b9a8d6', true, 1.5)
    + polyline(rps('achievedRps'), '#5aa9e6', true, 1.5);
  if (cpu) {
    svg += polyline(rps('currentCPU'), '#c07a2a')
      + `<line x1="8" y1="${78 - (60 * 68) / leftMax}" x2="272" y2="${78 - (60 * 68) / leftMax}" stroke="#c07a2a" stroke-width="1" stroke-dasharray="6 3"/><text x="270" y="${74 - (60 * 68) / leftMax}" font-size="6" fill="#c07a2a" text-anchor="end">target 60%</text>`;
  } else if (prom) {
    svg += polyline(rps('observedRps'), '#4a8452');
  }
  if (prom || cpu) svg += polyline(rep('desired'), '#c07a2a', true);
  svg += polyline(rep('actual'), '#2f6040', false, 1.5)
    + polyline(rep('ready'), '#3a7ca5')
    + polyline(rep('terminating'), '#dfae5d', true, 1.5)
    + polyline(rep('endpoints'), '#95a69a', true, 1);
  // failure markers
  for (const m of (chartSvg.marks || [])) {
    const x = 8 + ((new Date(m.at).getTime() - t0) / Math.max(1, el) * 264);
    if (Number.isFinite(x)) svg += `<text x="${x.toFixed(1)}" y="76" font-size="8" fill="#bd6655" text-anchor="middle">✕</text>`;
  }
  return svg + `</svg>`;
}

function legendHtml(lesson) {
  const prom = lesson === 'prometheus';
  const cpu = lesson === 'autoscale';
  let html = `<div class="timeline-legend"><span><i style="background:#8a6fb1"></i>offered (measured)</span><span><i style="background:#b9a8d6"></i>target</span><span><i style="background:#5aa9e6"></i>achieved ok</span>`;
  if (prom) html += `<span><i style="background:#4a8452"></i>Prometheus RPS</span><span><i style="background:#c07a2a"></i>HPA desired (pods)</span>`;
  else if (cpu) html += `<span><i style="background:#c07a2a"></i>CPU % (HPA-reported)</span><span><i style="background:#c07a2a"></i>HPA desired (pods)</span>`;
  return html + `<span><i style="background:#2f6040"></i>actual (pods)</span><span><i style="background:#3a7ca5"></i>ready (pods)</span><span><i style="background:#dfae5d"></i>terminating</span><span><i style="background:#95a69a"></i>endpoints</span><span>✕ request failure</span></div>`;
}

function marksHtml(timeline, upto) {
  const all = timeline.milestones || [];
  const shown = marksUpTo(timeline, upto);
  return `<div class="timeline-marks">${shown.map((m) => {
    const idx = all.indexOf(m);
    return `<button class="timeline-mark" data-mark="${idx}">${esc(fmtClock(m.at))} · ${esc(m.kind)}</button>`;
  }).join('')}</div>`;
}

function bindMarks(timeline) {
  timelineBox.querySelectorAll('.timeline-mark').forEach((b) => {
    b.onclick = () => {
      const m = timeline.milestones[Number(b.dataset.mark)];
      if (m && detailBox) detailBox.innerHTML = `<strong>${esc(m.kind)} · ${esc(fmtClock(m.at))}</strong><p>${esc(m.text)}</p><p class="timeline-why">Observer: ${esc(m.observer || '—')}. ${esc(m.detail || '')}</p>`;
    };
  });
}

function currentKey() {
  return `${window.labLesson || ''}:${window.labRun || ''}`;
}

function freezeAll() {
  paused = true; frozenKey = currentKey();
  if (pauseBtn) pauseBtn.textContent = 'Resume';
  window.dispatchEvent(new CustomEvent('lab:freeze'));
}

function resumeAll() {
  clearInterval(replayTimer);
  replayTimer = null;
  paused = false; cursor = -1; frozenKey = null;
  window.labCursor = null;
  if (pauseBtn) pauseBtn.textContent = 'Pause';
  window.dispatchEvent(new CustomEvent('lab:resume'));
}

function cancelReplay() {
  clearInterval(replayTimer);
  replayTimer = null;
  if (paused || cursor >= 0) resumeAll();
  else update();
}

window.addEventListener('lab:select', () => {
  cancelReplay();
  // Never show the previous lesson/run data labelled as the new selection:
  // clear everything immediately and show a loading state until fresh data.
  if (timelineBox) timelineBox.innerHTML = '';
  if (rateBox) rateBox.innerHTML = '<span class="timeline-empty">Loading selected-run observation…</span>';
  if (detailBox) detailBox.innerHTML = '';
  if (explainBox) { explainBox.hidden = true; explainBox.textContent = ''; }
  if (cursorLabel) cursorLabel.textContent = '';
});

// One summary renderer for both live (latest point) and cursor (historical
// point) views, so the headline always matches the chart under it.
function summaryHtml(point, lesson, timeline) {
  const latest = point;
  const stale = latest.stale || latest.observedRps == null;
  const cpu = lesson === 'autoscale';
  const prom = lesson === 'prometheus';
  const head = cpu
    ? (latest.currentCPU == null ? 'CPU unavailable' : `${latest.currentCPU}% CPU (HPA-reported at poll time)`)
    : prom
      ? (stale ? 'stale — no fresh Prometheus sample (not zero)' : `${Number(latest.observedRps).toFixed(1)} requests / second`)
      : `${latest.ready ?? '?'} ready pods · ${latest.actual ?? '?'} actual`;
  const failCount = (timeline.milestones || []).filter((m) => m.kind === 'failure').length;
  const scrapedAt = prom && !stale && latest.observedAt ? ` · rate evaluated ${fmtClock(latest.observedAt)}` : '';
  const sampledAt = prom && latest.sampleAt ? ` · stored sample ${fmtClock(latest.sampleAt)}` : '';
  const scrapeNote = prom && latest.scrapeOk === false ? ' · scrape FAILED (not zero)' : '';
  const hpaText = latest.desired == null ? 'desired ?' : `desired ${latest.desired}`;
  return `<strong>${esc(head)}</strong><span class="timeline-meta">offered ${latest.offeredRps ?? 0} / achieved ${latest.achievedRps ?? 0} req/s (target ${latest.offeredTarget ?? 0})${esc(scrapedAt)}${esc(sampledAt)}${esc(scrapeNote)} · ${esc(hpaText)} · actual ${latest.actual ?? '?'} · ready ${latest.ready ?? '?'}${latest.terminating ? ` · terminating ${latest.terminating}` : ''} · endpoints ${latest.endpoints ?? '?'}${failCount ? ` · ${failCount} failures` : ''}${prom ? ' · target 5 req/s per pod' : ''}${cpu && latest.currentCPU != null ? ` · CPU ${latest.currentCPU}% (target ${latest.cpuTarget ?? 60}%)` : ''}</span>`
    + (prom && latest.counterTotal != null ? `<span class="timeline-meta">raw counter ${Math.round(latest.counterTotal)} requests · scrape targets ${latest.scrapeTargets ?? '?'}${latest.externalCurrent != null ? ` · KEDA external avg ${latest.externalCurrent} req/s per pod (target ${latest.externalTarget ?? '?'} avg)` : (latest.externalRaw != null ? ` · KEDA external unavailable (raw ${escape(String(latest.externalRaw))})` : '')}</span>` : '');
}

async function update() {
  try {
    const runId = window.labRun ? window.labRun : null;
    const key = currentKey();
    if (frozenKey !== null && frozenKey !== key) {
      // run/lesson changed under a frozen view: cancel and resume live
      paused = false; cursor = -1; frozenKey = null;
      if (pauseBtn) pauseBtn.textContent = 'Pause';
    }
    const [timeline, appState] = await Promise.all([
      fetch(runId ? `/api/runs/${encodeURIComponent(runId)}/timeline` : '/api/timeline').then((r) => r.json()),
      fetch(runId ? `/api/runs/${encodeURIComponent(runId)}` : '/api/state').then((r) => r.json()).catch(() => ({})),
    ]);
    if (key !== currentKey()) return; // selection changed mid-fetch: never paint stale data
    const lesson = window.labLesson || appState.lesson || 'prometheus';
    if (paused || cursor >= 0) { frozenKey = currentKey(); return; } // frozen while fetching: keep the frozen view
    const scaling = runId ? true : (appState.load?.active || appState.running || appState.resetting || appState.scenario === 'prometheus' || appState.scenario === 'autoscale');
    const points = (timeline.points || []).slice(-180);
    const frozen = paused || cursor >= 0;
    if (!scaling || !points.length) {
      if (!frozen) {
        rateBox.innerHTML = '<span class="timeline-empty">Create a run, start manual load, or run the experiment to observe.</span>';
        if (timelineBox) timelineBox.innerHTML = '';
      }
      return;
    }
    if (frozen) return; // whole observation stays frozen; data keeps flowing server-side
    rateBox.innerHTML = summaryHtml(points.at(-1), lesson, timeline);

    if (timelineBox) {
      chartSvg.marks = (timeline.milestones || []).filter((m) => m.kind === 'failure');
      timelineBox.innerHTML = chartSvg(points, lesson) + legendHtml(lesson) + marksHtml(timeline, null);
      bindMarks(timeline);
      if (scrubInput) {
        const t0 = new Date(points[0].at).getTime();
        const t1 = new Date(points.at(-1).at).getTime();
        scrubInput.min = String(t0); scrubInput.max = String(t1); scrubInput.value = String(t1);
        if (cursorLabel) cursorLabel.textContent = `elapsed ${fmtElapsed(t1 - t0)} · ${points.length} samples`;
      }
      if (explainBox) {
        explainBox.hidden = false;
        explainBox.textContent = deriveExplanation(points, lesson);
      }
    }
  } catch { rateBox.textContent = 'Metric unavailable'; }
}

function renderCursor(points, timeline, lesson, upto) {
  const slice = points.filter((p) => new Date(p.at).getTime() <= upto);
  if (!slice.length || !timelineBox) return;
  const scoped = { ...timeline, milestones: marksUpTo(timeline, upto) };
  chartSvg.marks = scoped.milestones.filter((m) => m.kind === 'failure');
  timelineBox.innerHTML = chartSvg(slice, lesson) + legendHtml(lesson) + marksHtml(timeline, upto);
  bindMarks(timeline);
  const cursorPoint = slice.at(-1);
  rateBox.innerHTML = summaryHtml(cursorPoint, lesson, scoped);
  const at = slice.at(-1);
  window.dispatchEvent(new CustomEvent('lab:cursor', { detail: {
    upto, lesson,
    pods: at.podsSnapshot || null,
    endpoints: at.endpointsSnapshot || null,
  } }));
  if (cursorLabel) cursorLabel.textContent = `cursor ${fmtClock(new Date(upto).toISOString())} · ${slice.length}/${points.length} samples`;
  if (explainBox) {
    explainBox.hidden = false;
    explainBox.textContent = deriveExplanation(slice, lesson);
  }
}

if (pauseBtn) {
  pauseBtn.onclick = () => {
    if (paused) resumeAll();
    else freezeAll();
    if (!paused) update();
  };
}

if (scrubInput) {
  scrubInput.oninput = async () => {
    const runId = window.labRun ? window.labRun : null;
    const key = currentKey();
    const [timeline] = await Promise.all([
      fetch(runId ? `/api/runs/${encodeURIComponent(runId)}/timeline` : '/api/timeline').then((r) => r.json()),
    ]);
    if (key !== currentKey()) return;
    const points = (timeline.points || []).slice(-180);
    if (!points.length) return;
    freezeAll();
    cursor = Number(scrubInput.value);
    window.labCursor = cursor;
    renderCursor(points, timeline, window.labLesson || 'prometheus', cursor);
  };
}

if (document.getElementById('timeline-replay')) {
  document.getElementById('timeline-replay').onclick = async () => {
    clearInterval(replayTimer);
    const runId = window.labRun ? window.labRun : null;
    const key = currentKey();
    const timeline = await fetch(runId ? `/api/runs/${encodeURIComponent(runId)}/timeline` : '/api/timeline').then((r) => r.json());
    if (key !== currentKey()) return;
    const points = (timeline.points || []).slice(-180);
    if (!points.length || !timelineBox) return;
    freezeAll();
    const lesson = window.labLesson || 'prometheus';
    let i = 0;
    replayTimer = setInterval(() => {
      if (key !== currentKey()) { clearInterval(replayTimer); replayTimer = null; return; }
      i += 1;
      if (i >= points.length) {
        clearInterval(replayTimer);
        replayTimer = null;
        resumeAll();
        update();
        return;
      }
      const upto = new Date(points[i].at).getTime();
      cursor = upto;
      window.labCursor = upto;
      if (scrubInput) scrubInput.value = String(upto);
      renderCursor(points.slice(0, i + 1), timeline, lesson, upto);
      if (cursorLabel) cursorLabel.textContent = `Replaying ${i + 1}/${points.length} — live updates paused, raw evidence stays downloadable.`;
    }, 300);
  };
}

if (document.getElementById('evidence-download')) {
  document.getElementById('evidence-download').onclick = async () => {
    const runId = window.labRun ? window.labRun : null;
    const data = await fetch(runId ? `/api/evidence?run=${encodeURIComponent(runId)}` : '/api/evidence').then((r) => r.json());
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `scaling-lab-evidence-${runId || 'legacy'}-${Date.now()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
}

update();
setInterval(update, 5000);
