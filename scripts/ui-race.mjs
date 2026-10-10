// UI regression: out-of-order /api/state responses must not flip selection.
// Two same-lesson runs (A retained, B fresh). The first state response is
// delayed 4s and carries only A; newer responses carry A+B with B selected.
// Asserts B stays selected and A-only data never renders into B's panel.
// Exits nonzero on failure. Requires one free slot; cleans up only run B.
import { chromium } from 'playwright-core';

const BASE = process.argv[2] || 'http://127.0.0.1:4173';
let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures += 1;
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(`pageerror: ${e.message}`));
page.on('unhandledrejection', (r) => jsErrors.push(`unhandled: ${String(r).slice(0, 200)}`));

await page.goto(BASE, { waitUntil: 'networkidle' });
const st0 = await page.evaluate(() => fetch('/api/state').then((r) => r.json()));
const live0 = (st0.runs || []).filter((r) => r.status === 'ready' || r.status === 'creating');
if (live0.length >= (st0.maxActiveRuns || 2)) {
  console.log('ABORT: no free run slot.');
  await browser.close();
  process.exit(2);
}
const retainedA = live0[0]?.id || null;
console.log('retained:', retainedA);

// Create run B (connections) via API and wait until ready.
const created = await page.evaluate(() => fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lesson: 'connections' }) }).then((r) => r.json()));
if (!created.id) { console.log('ABORT: creation failed', JSON.stringify(created)); await browser.close(); process.exit(2); }
const runB = created.id;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(5000);
  const s = await page.evaluate(() => fetch('/api/state').then((r) => r.json()));
  const rec = (s.runs || []).find((x) => x.id === runB);
  if (rec && rec.status === 'ready') break;
}
// Go to connections lesson and select B explicitly.
await page.click('.lesson-link[data-index="0"]');
await page.waitForTimeout(1000);
await page.selectOption('#run-select', runB);
await page.waitForTimeout(2000);
check('B selected', (await page.evaluate(() => window.labRun)) === runB);

// Delay the next /api/state response 4s and serve an A-only snapshot,
// simulating a slow out-of-order poll from before B existed/was selected.
let delayedOnce = false;
await page.route('**/api/state', async (route) => {
  if (!delayedOnce) {
    delayedOnce = true;
    await new Promise((r) => setTimeout(r, 4000));
    const real = await fetch(`${BASE}/api/state`).then((r) => r.json());
    real.runs = (real.runs || []).filter((r) => r.id !== runB);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(real) });
  } else {
    await route.continue();
  }
});
await page.waitForTimeout(9000); // let the stale response land between fresh polls
check('selection still B after stale response', (await page.evaluate(() => window.labRun)) === runB);
check('panel never rendered A-only data', (await page.textContent('#run-panel-state')).includes(runB));
await page.unroute('**/api/state');

// Section 2: a delayed timeline response for the previous selection must not
// paint into the newly selected lesson/run.
let delayedTimelineOnce = false;
await page.route('**/api/runs/*/timeline', async (route) => {
  const url = route.request().url();
  if (!delayedTimelineOnce && url.includes(`/api/runs/${runB}/timeline`)) {
    delayedTimelineOnce = true;
    await new Promise((r) => setTimeout(r, 4000));
  }
  await route.continue();
});
await page.click('.lesson-link[data-index="6"]'); // switch to Prometheus/A
await page.waitForTimeout(8000); // let the stale B timeline land mid-flight
const head = await page.textContent('#prometheus-rate');
check('late B timeline never painted into A view', /requests \/ second|stale —/.test(head));
await page.unroute('**/api/runs/*/timeline');

// Cleanup owned run B only.
await page.evaluate(async (id) => { await fetch(`/api/runs/${id}`, { method: 'DELETE' }); }, runB);
console.log(`js errors: ${jsErrors.length ? jsErrors.join(' | ') : 'none'}`);
if (jsErrors.length) failures += 1;
await browser.close();
console.log(failures ? `FAILED (${failures})` : 'RACE REGRESSION PASSED');
process.exit(failures ? 1 : 0);