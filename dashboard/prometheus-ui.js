const output = document.getElementById('prometheus-rate');
async function update() {
  try {
    const state = await fetch('/api/state').then(response => response.json());
    if (state.scenario !== 'prometheus') { output.textContent = 'Run lesson 07 to observe'; return; }
    const samples = state.events.filter(event => event.type === 'prometheus' && Number.isFinite(event.data?.rps)).slice(-40);
    if (!samples.length) { output.textContent = 'Waiting for samples…'; return; }
    const latest = samples.at(-1).data.rps;
    const ceiling = Math.max(15, ...samples.map(event => event.data.rps));
    const points = samples.map((event, index) => `${8 + index * 264 / Math.max(1, samples.length - 1)},${78 - event.data.rps * 68 / ceiling}`).join(' ');
    output.innerHTML = `<strong>${latest.toFixed(1)} requests / second</strong><svg class="rate-chart" viewBox="0 0 280 90" role="img" aria-label="Recent Prometheus request rate"><line x1="8" y1="78" x2="272" y2="78" stroke="#cbd8ca"/><polyline points="${points}" fill="none" stroke="#4a8452" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  } catch { output.textContent = 'Metric unavailable'; }
}
update();
setInterval(update, 2000);
