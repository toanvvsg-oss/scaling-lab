// Single-allocation race: two tabs start two different lessons at once.
// Exactly one Start returns 202; the other 409s and provisions nothing.
// Exits nonzero on failure. Ends the winner; never touches retained history.
import { chromium } from 'playwright-core';

const BASE = process.argv[2] || 'http://127.0.0.1:4173';
let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures += 1;
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const a = await browser.newPage();
const b = await browser.newPage();
for (const p of [a, b]) {
  p.on('pageerror', (e) => { console.log(`FAIL pageerror: ${e.message}`); failures += 1; });
}
await a.goto(BASE, { waitUntil: 'networkidle' });
await b.goto(BASE, { waitUntil: 'networkidle' });

const flowA = await a.evaluate(() => fetch('/api/lesson').then((r) => r.json()));
if (flowA.active) {
  console.log('ABORT: a lesson is already active; ending it here would touch someone else’s environment.');
  await browser.close();
  process.exit(2);
}

// Fire both starts concurrently from independent tabs.
const [ra, rb] = await Promise.all([
  a.evaluate(() => fetch('/api/lesson/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lesson: 'connections' }) }).then((r) => r.status)),
  b.evaluate(() => fetch('/api/lesson/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lesson: 'rollout' }) }).then((r) => r.status)),
]);
console.log(`start statuses: tabA=${ra} tabB=${rb}`);
check('exactly one winner', (ra === 202 && rb === 409) || (ra === 409 && rb === 202));

// The loser provisioned nothing: at most one owned namespace may exist.
const winner = ra === 202 ? a : b;
let f = null;
for (let i = 0; i < 40; i++) {
  await winner.waitForTimeout(5000);
  f = await winner.evaluate(() => fetch('/api/lesson').then((r) => r.json()));
  if (f.active?.status === 'ready' || f.active?.status === 'failed') break;
}
check('winner reaches a terminal start state', ['ready', 'failed'].includes(f?.active?.status));
const states = await winner.evaluate(() => fetch('/api/state').then((r) => r.json()));
const live = (states.runs || []).filter((r) => !['deleted', 'failed'].includes(r.status));
check('single allocation holds across tabs', live.length <= 1);
if (f?.active) {
  await winner.evaluate(() => fetch('/api/lesson/end', { method: 'POST' }));
  let ended = false;
  for (let i = 0; i < 48; i++) {
    await winner.waitForTimeout(5000);
    const g = await winner.evaluate(() => fetch('/api/lesson').then((r) => r.json()));
    if (g.active === null) { ended = true; break; }
  }
  check('winner ends cleanly', ended);
}
await browser.close();
console.log(failures ? `FAILED (${failures})` : 'RACE CHECKS PASSED');
process.exit(failures ? 1 : 0);
