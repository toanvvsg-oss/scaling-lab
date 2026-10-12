// History and reconnect acceptance for the single-lesson console.
// Starts a lesson, reloads mid-practice (selection persists by ID, practice
// reconnects without duplicating the environment), downloads evidence, ends
// the lesson, reloads again, and asserts the history entry and its evidence
// survive. Creates and ends only its own lesson; retained history untouched.
import { chromium } from 'playwright-core';

const BASE = process.argv[2] || 'http://127.0.0.1:4173';
let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures += 1;
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 2000 } });
const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(e.message));
await page.goto(BASE, { waitUntil: 'networkidle' });

const flow = () => page.evaluate(() => fetch('/api/lesson').then((r) => r.json()));
const waitFlow = async (pred, timeoutMs = 200000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const f = await flow();
    if (pred(f)) return f;
    await page.waitForTimeout(5000);
  }
  return null;
};

{
  const f = await flow();
  if (f.active) {
    console.log('ABORT: a lesson is already active.');
    await browser.close();
    process.exit(2);
  }
}

// Start connections, then reload mid-practice.
await page.getByRole('button', { name: '01 Connection reuse' }).click();
await page.waitForTimeout(800);
await page.getByRole('button', { name: /Start lesson/ }).click();
let f = await waitFlow((x) => x.active?.status === 'ready' || x.active?.status === 'failed');
check('lesson ready before reload', f?.active?.status === 'ready');
const runId = f?.active?.runId || '';

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
check('lesson selection persists by ID across reload', (await page.locator('h1').textContent()).includes('Connection reuse'));
await page.getByRole('button', { name: /Run \+ verify/ }).waitFor({ timeout: 30000 });
check('practice reconnects without duplicating the environment', (await flow()).active?.runId === runId);

// Evidence downloads, then end, then history survives another reload.
const dl = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
const evBtn = page.getByRole('button', { name: 'Download evidence' });
if ((await evBtn.count()) > 0) await evBtn.first().click();
check('practice evidence downloads', (await dl) !== null);
await page.getByRole('button', { name: 'End lesson', exact: true }).first().click();
f = await waitFlow((x) => x.active === null, 240000);
check('lesson ends', f && f.active === null);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
f = await flow();
check('history survives reload', (f.history || []).some((h) => h.run === runId));
const ev = await page.evaluate((id) => fetch(`/api/evidence?run=${id}`).then((r) => r.json()).catch(() => null), runId);
check('archived evidence stays fetchable', ev?.run === runId);

console.log(`js errors: ${jsErrors.length ? jsErrors.join(' | ') : 'none'}`);
if (jsErrors.length) failures += 1;
await browser.close();
console.log(failures ? `FAILED (${failures})` : 'HISTORY CHECKS PASSED');
process.exit(failures ? 1 : 0);
