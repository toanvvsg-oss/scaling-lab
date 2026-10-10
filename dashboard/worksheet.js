document.querySelector('.sheet-result').insertAdjacentHTML('beforebegin', `
  <h2 style="margin-top:36px">Autoscaling capacity</h2>
  <p class="sheet-note">Use a measured safe per-pod rate at your latency target. This arithmetic checks whether the maximum replica count can cover peak demand; HPA still needs a suitable metric and time to react.</p>
  <div class="sheet-grid">
    <div class="field"><label for="peak">Expected peak requests per second</label><input id="peak" type="number" min="1" max="100000" value="250"><p>Use a representative burst or sustained peak.</p></div>
    <div class="field"><label for="capacity">Measured safe requests per second per pod</label><input id="capacity" type="number" min="1" max="100000" value="100"><p>Measure at the latency and error rate you require.</p></div>
    <div class="field"><label for="minPods">Minimum replicas</label><input id="minPods" type="number" min="1" max="1000" value="2"><p>Baseline capacity before a scaling decision arrives.</p></div>
    <div class="field"><label for="maxPods">Maximum replicas</label><input id="maxPods" type="number" min="1" max="1000" value="5"><p>Maximum capacity permitted by the HPA.</p></div>
    <div class="field"><label for="cpuRequest">CPU request per pod (millicores)</label><input id="cpuRequest" type="number" min="1" max="100000" value="100"><p>CPU utilization is calculated against this request.</p></div>
    <div class="field"><label for="cpuTarget">HPA CPU utilization target (%)</label><input id="cpuTarget" type="number" min="1" max="100" value="60"><p>Use the observed CPU-to-throughput relationship to tune it.</p></div>
  </div>`);
const ids = ['request','drain','shutdown','grace','proxy','client','peak','capacity','minPods','maxPods','cpuRequest','cpuTarget'];
const input = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
let report;
function calculate() {
  const v = Object.fromEntries(ids.map(id => [id, Number(input[id].value)]));
  const margin = 2;
  const neededPods = Math.ceil(v.peak / v.capacity);
  const checks = [
    { pass: ids.every(id => Number.isFinite(v[id]) && v[id] >= Number(input[id].min) && v[id] <= Number(input[id].max)), text: 'All values are positive and within the worksheet range' },
    { pass: v.shutdown >= v.request + margin, text: `App shutdown budget ≥ longest request + ${margin}s margin` },
    { pass: v.grace >= v.drain + v.shutdown + margin, text: `Pod grace ≥ preStop + app shutdown budget + ${margin}s margin` },
    { pass: v.proxy >= v.request + margin, text: `Proxy read timeout ≥ longest request + ${margin}s margin` },
    { pass: v.client >= v.request + margin, text: `Client timeout ≥ longest request + ${margin}s margin` },
    { pass: v.maxPods >= v.minPods, text: 'HPA maximum replicas ≥ minimum replicas' },
    { pass: Number.isFinite(neededPods) && v.maxPods >= neededPods, text: `Maximum replicas can cover the peak (estimated need: ${neededPods})` },
    { pass: v.cpuRequest > 0 && v.cpuTarget >= 1 && v.cpuTarget <= 100, text: 'CPU request and HPA utilization target are defined' }
  ];
  const pass = checks.every(x => x.pass);
  document.getElementById('verdict').textContent = pass ? 'Timing budget is internally consistent' : 'Adjust the values below';
  document.getElementById('checks').innerHTML = checks.map(x => `<li class="${x.pass?'good':'bad'}">${x.pass?'✓':'✕'} ${x.text}</li>`).join('');
  report = { generatedAt: new Date().toISOString(), values: v, marginSeconds: margin, estimatedPeakReplicas: neededPods, checks, pass, note: 'Validate with live traffic in the target environment.' };
}
ids.forEach(id => input[id].addEventListener('input', calculate));
document.getElementById('download').onclick = () => {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = 'scaling-lab-worksheet.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
calculate();
