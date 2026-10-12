// Browser acceptance for the single-lesson React console (playwright-core
// with Google Chrome). Every check asserts; any FAIL exits nonzero.
// Screenshots and downloaded evidence go to results/ (git-ignored).
//
//   node scripts/ui-accept.mjs [baseUrl]
//
// Requires NO active lesson (aborts otherwise, preserving it). Cleans up
// only the lessons it starts; retained history is never touched. Lesson
// selection is by stable title text, never by catalog index.
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

// 0. Precheck: no active lesson, or fail fast without touching it.
await page.goto(BASE, { waitUntil: 'networkidle' });
{
  const f = await flow();
  console.log(`active: ${f.active ? `${f.active.lesson}/${f.active.status}` : 'none'}, history: ${(f.history || []).length}`);
  if (f.active) {
    console.log('ABORT: a lesson is already active; ending it here would touch someone else’s environment.');
    await browser.close();
    process.exit(2);
  }
}
check('no JS errors on load', jsErrors.length === 0);

// 1. Chapters render by stable identity; preview provisions nothing.
check('chapter: follow one request', (await page.locator('text=Follow one request').count()) >= 1);
check('chapter: take the system to GKE', (await page.locator('text=Take the system to GKE').count()) >= 1);
await page.getByRole('button', { name: '01 Connection reuse' }).click();
await page.waitForTimeout(1000);
check('preview provisions nothing', (await page.locator('text=nothing is provisioned yet').count()) >= 1);
{
  const f = await flow();
  check('selecting a lesson creates no environment', f.active === null);
}

// 2. Start reaches Ready with reported stages.
await page.getByRole('button', { name: /Start lesson/ }).click();
let f = await waitFlow((x) => x.active?.status === 'ready' || x.active?.status === 'failed');
check('lesson ready', f?.active?.status === 'ready');
const runId = f?.active?.runId || '';
check('prerequisite stage reported', (f?.active?.stages || []).some((s) => s.stage === 'check-prerequisites'));
// Duplicate Start is refused without provisioning.
{
  const dup = await page.evaluate(() => fetch('/api/lesson/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lesson: 'rollout' }) }).then((r) => r.status));
  check('duplicate start 409s', dup === 409);
}

// 3. Connections practice: guided actions, then the one-click verifier.
await page.getByRole('button', { name: /Run \+ verify/ }).waitFor({ timeout: 30000 });
await page.getByRole('button', { name: 'Send 8 reused requests' }).click();
await page.waitForTimeout(6000);
await page.getByRole('button', { name: /Run \+ verify/ }).click();
let verdict = '';
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(5000);
  const ev = await page.evaluate((id) => fetch(`/api/evidence?run=${id}`).then((r) => r.json()).catch(() => null), runId);
  if (ev?.result?.status) { verdict = ev.result.status; break; }
}
check('connections verifier passes', verdict === 'pass');

// 4. Switch-cancel preserves the environment; switch-confirm ends it and
// opens a preview without auto-start.
await page.getByRole('button', { name: '13 Rolling deployment' }).click();
await page.waitForTimeout(800);
await page.getByRole('button', { name: /Switch from/ }).click();
await page.waitForTimeout(800);
check('switch dialog states no auto-start', (await page.locator('text=will not start automatically').count()) >= 1);
await page.getByRole('button', { name: /leave everything untouched/i }).click();
await page.waitForTimeout(1000);
check('cancel keeps environment', (await flow()).active?.runId === runId);
await page.getByRole('button', { name: /Switch from/ }).click();
await page.waitForTimeout(800);
await page.getByRole('button', { name: /End current \+ open preview/ }).click();
f = await waitFlow((x) => x.active === null, 240000);
check('confirm ends the lesson', f && f.active === null);
check('no auto-start after switch', (await flow()).active === null);
check('preview offers Start', (await page.getByRole('button', { name: /Start lesson/ }).count()) >= 1);

// 5. Spot-check two more lessons: start → ready → end each.
for (const [title, re] of [["03 Measure one pod's capacity", /Start lesson/], ['09 Pending pods and node capacity', /Start lesson/]]) {
  await page.getByRole('button', { name: title }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: re }).click();
  f = await waitFlow((x) => x.active?.status === 'ready' || x.active?.status === 'failed');
  check(`${title} reaches ready`, f?.active?.status === 'ready');
  await page.getByRole('button', { name: 'End lesson', exact: true }).first().click();
  f = await waitFlow((x) => x.active === null, 240000);
  check(`${title} ends cleanly`, f && f.active === null);
}

// 6. History is read-only and downloadable.
{
  const h = await flow();
  check('history retained three lessons', (h.history || []).length >= 3);
  const dl = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
  await page.locator('#history button', { hasText: 'Evidence' }).first().click();
  check('history evidence downloads', (await dl) !== null);
}

await page.screenshot({ path: `${OUT}accept-ui.png` });
console.log(`js errors (incl. unhandled rejections): ${jsErrors.length ? jsErrors.join(' | ') : 'none'}`);
if (jsErrors.length) failures += 1;
await browser.close();
console.log(failures ? `FAILED (${failures})` : 'ALL ACCEPTANCE CHECKS PASSED');
process.exit(failures ? 1 : 0);
