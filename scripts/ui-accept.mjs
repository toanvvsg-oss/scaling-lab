// Browser acceptance for scaling-lab. Uses the installed Google Chrome via
// playwright-core (install once: npm install --no-save playwright-core).
// Every check asserts; any FAIL exits nonzero. Screenshots and downloaded
// evidence go to results/ (git-ignored).
//
//   node scripts/ui-accept.mjs [baseUrl]
//
// Requires one free active-run slot (max 2). Cleans up only runs it creates;
// retained runs are never touched.
import { mkdirSync, existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const BASE = process.argv[2] || 'http://127.0.0.1:4173';
const OUT = new URL('../results/', import.meta.url).pathname;
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures += 1;
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 2200 } });
const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(`pageerror: ${e.message}`));
page.on('unhandledrejection', (r) => jsErrors.push(`unhandled: ${String(r).slice(0, 200)}`));

async function state() {
  return page.evaluate(() => fetch('/api/state').then((r) => r.json()));
}
async function waitRunReady(timeoutMs = 200000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const st = await page.textContent('#run-panel-state');
    if (st.includes('ready')) return page.evaluate(() => document.getElementById('run-select').value);
    await page.waitForTimeout(5000);
  }
  return '';
}

// 0. Precheck: free slot, or fail fast with a useful error.
await page.goto(BASE, { waitUntil: 'networkidle' });
{
  const st = await state();
  const live = (st.runs || []).filter((r) => r.status === 'ready' || r.status === 'creating');
  console.log(`slots: ${live.length}/${st.maxActiveRuns || 2} ${live.map((r) => r.id)}`);
  if (live.length >= (st.maxActiveRuns || 2)) {
    console.log('ABORT: no free run slot; clean up a scratch run first, preserving retained runs.');
    await browser.close();
    process.exit(2);
  }
}
check('no refresh errors on load', await page.evaluate(() => window.labLastError == null));

// 1. Stepper + lesson-specific prediction labels on lesson 01.
const steps = await page.$$eval('#stepper .step-pill', (els) => els.map((e) => e.firstChild.textContent.trim()));
check('stepper shows six phases', steps.join(',') === 'baseline,predict,act,observe,explain,checks');
const guesses = await page.$$eval('#guess-options button', (els) => els.map((e) => e.textContent));
check('connection guesses are lesson-specific', guesses.some((g) => /edge connection/i.test(g)));

// 2. Prediction gating: reveal before any observation must be refused.
await page.click('#guess-options button');
await page.waitForTimeout(800);
await page.click('#predict-reveal');
await page.waitForTimeout(800);
check('reveal gated before observation', /Observe after predicting|prediction first/i.test(await page.textContent('#predict-state')));

// 3. Guided batch action on an auto-created connections run.
await page.click('.lesson-link[data-index="0"]');
await page.waitForTimeout(800);
await page.click('#run');
let runId = '';
for (let i = 0; i < 48; i++) {
  await page.waitForTimeout(5000);
  if (await page.evaluate(() => !!document.querySelector('#verdict .verdict-card'))) break;
  const st = await page.textContent('#run-panel-state');
  if (st.includes('ready')) { runId = await page.evaluate(() => document.getElementById('run-select').value); break; }
}
if (!runId) {
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(5000);
    const st = await page.textContent('#run-panel-state');
    if (st.includes('ready')) { runId = await page.evaluate(() => document.getElementById('run-select').value); break; }
  }
}
check('run auto-created and selected', Boolean(runId));
await page.click('[data-action="reuse-batch"]');
await page.waitForTimeout(9000);
const trace = await page.textContent('#trace');
check('trace shows request/socket IDs', /req [0-9a-f]{8} · edge \S+ → …[a-z0-9]{5}\/\S+/.test(trace));
console.log('action state:', await page.textContent('#action-state'));

// 4. Cleanup the connections run to free its slot (cancel first, then confirm).
await page.click('#run-cleanup-open');
await page.waitForSelector('#cleanup-dialog[open]', { timeout: 5000 });
await page.click('#cleanup-cancel');
await page.waitForTimeout(1000);
check('cleanup cancel keeps run', (await page.textContent('#run-panel-state')).includes(runId));
await page.click('#run-cleanup-open');
await page.click('#cleanup-confirm');
let gone = false;
for (let i = 0; i < 24; i++) {
  await page.waitForTimeout(5000);
  const s = await state();
  if (!(s.runs || []).some((x) => x.id === runId && ['ready', 'creating', 'deleting'].includes(x.status))) { gone = true; break; }
}
check('cleanup deletes run', gone);

// 5. Lesson 07: explicitly create a fresh prometheus run (never touch retained A).
await page.click('.lesson-link[data-index="6"]');
await page.waitForTimeout(1000);
const beforeIds = await page.evaluate(() => fetch('/api/state').then(r => r.json()).then(s => (s.runs || []).map(x => x.id)));
await page.click('#run-new');
let promId = '';
for (let i = 0; i < 48; i++) {
  await page.waitForTimeout(5000);
  const st = await page.textContent('#run-panel-state');
  const sel = await page.evaluate(() => document.getElementById('run-select').value);
  if (st.includes('ready') && sel && !beforeIds.includes(sel)) { promId = sel; break; }
}
check('fresh prometheus run created and selected', Boolean(promId));
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(2000);
  const lab = await page.evaluate(() => window.labRun);
  if (lab === promId) break;
}
console.log('labRun synced:', await page.evaluate(() => window.labRun));
await page.selectOption('#load-profile', 'steady');
await page.selectOption('#load-duration', '300');
await page.click('#load-start');
await page.waitForTimeout(10000);
const loadText = await page.textContent('#load-state');
console.log('load-state:', loadText.slice(0, 160));
check('load active before pause', /measured \d+ offered/.test(loadText));
// Reload continuity: same lesson/run/profile reconnect, counters continue, nothing restarts.
const beforeReload = await page.evaluate(() => ({
  title: document.getElementById('lesson-title').textContent,
  run: document.getElementById('run-select').value,
  profile: document.getElementById('load-profile').value,
}));
const beforeTotal = await page.evaluate(() => fetch('/api/state').then(r => r.json()).then(s => {
  const rec = (s.runs || []).find(x => x.id === document.getElementById('run-select').value);
  return rec && rec.load ? rec.load.total : -1;
}));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(6000);
check('lesson restored after reload', (await page.textContent('#lesson-title')) === beforeReload.title);
check('run restored after reload', (await page.evaluate(() => document.getElementById('run-select').value)) === beforeReload.run);
const afterTotal = await page.evaluate(() => fetch('/api/state').then(r => r.json()).then(s => {
  const rec = (s.runs || []).find(x => x.id === document.getElementById('run-select').value);
  return rec && rec.load ? { total: rec.load.total, active: rec.load.active, profile: rec.load.profile } : null;
}));
check('load reconnected, counters continue', afterTotal && afterTotal.active && afterTotal.profile === beforeReload.profile && afterTotal.total >= beforeTotal && beforeTotal > 0);
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(5000);
  const max = await page.evaluate(() => document.getElementById('timeline-scrub').max);
  if (Number(max) > 0) break;
}
await page.click('#timeline-pause');
await page.waitForTimeout(1000);
const snap = await page.textContent('#pods') + await page.textContent('#timeline') + await page.textContent('#trace');
await page.waitForTimeout(4000);
check('pause freezes pods/events/trace', (await page.textContent('#pods') + await page.textContent('#timeline') + await page.textContent('#trace')) === snap);
check('pause pill shows PAUSED', (await page.textContent('#live-pill')) === 'PAUSED');
await page.click('#timeline-replay');
await page.waitForTimeout(5000);
await page.screenshot({ path: `${OUT}accept-ui.png` });
// wait for replay to end on its own (button back to Pause), then use
// explicit pause/resume clicks so the test never races the replay timer.
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(2000);
  if ((await page.textContent('#timeline-pause')).trim() === 'Pause') break;
}
check('live after replay ends', (await page.textContent('#live-pill')) === 'LIVE');
await page.click('#timeline-pause'); // freeze
await page.waitForTimeout(1000);
await page.click('#timeline-pause'); // resume
await page.waitForTimeout(3000);
check('resume restores LIVE under load', (await page.textContent('#live-pill')) === 'LIVE');
await page.click('#load-stop');
await page.waitForTimeout(2000);
check('load stopped clean', (await page.textContent('#load-state')).includes('Manual load idle'));

// 6. Evidence download + final cleanup of the prometheus run.
const dl = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
await page.click('#run-evidence');
check('run evidence downloads', (await dl) !== null);
await page.click('#run-cleanup-open');
await page.waitForSelector('#cleanup-dialog[open]', { timeout: 5000 });
await page.screenshot({ path: `${OUT}accept-cleanup-dialog.png` });
await page.click('#cleanup-confirm');
gone = false;
for (let i = 0; i < 24; i++) {
  await page.waitForTimeout(5000);
  const s = await state();
  if (!(s.runs || []).some((x) => x.id === promId && ['ready', 'creating', 'deleting'].includes(x.status))) { gone = true; break; }
}
check('prometheus run cleaned up', gone);
const arch = await state().then((s) => s.archivedRuns || []);
check('archives listed after cleanups', arch.includes(promId) && arch.includes(runId));

console.log(`js errors (incl. unhandled rejections): ${jsErrors.length ? jsErrors.join(' | ') : 'none'}`);
if (jsErrors.length) failures += 1;
await browser.close();
console.log(failures ? `FAILED (${failures})` : 'ALL ACCEPTANCE CHECKS PASSED');
process.exit(failures ? 1 : 0);
