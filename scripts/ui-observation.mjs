import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

// Real frontend, controlled API responses. No Kubernetes calls or mutations.
const ids = ['aaaabbbb', 'ccccdddd'];
const now = Date.now(), points = [0, 1, 2].map(i => ({
  at: new Date(now - 15000 + i * 5000).toISOString(), actual: 2, ready: 2, desired: 2,
  offeredRps: 15, achievedRps: 15, observedRps: 15, stale: false,
  podsSnapshot: [{ name: 'app-history-' + i, ready: true }],
  endpointsSnapshot: [{ pod: 'app-history-' + i, ready: true }],
}));
const stats = { total: 10, ok2xx: 9, http4xx: 0, http5xx: 1, transport: 0,
  recentErrors: [{ at: new Date(now - 1000).toISOString(), status: 500, pod: 'app-current', requestId: 'error-1', hint: 'App-emitted demo error.' }] };
const runs = ids.map(id => ({ id, lesson: 'prometheus', status: 'ready', namespace: 'scaling-run-' + id,
  load: { active: true, profile: 'steady', elapsedMs: 15000, total: 10, failures: 1, targetRps: 15 },
  events: [], rev: 1, statusStats: stats }));
const cluster = { connected: true, pods: [{ name: 'app-current', ready: true }],
  endpoints: [{ pod: 'app-current', ready: true }] };
let base, mutations = 0, delayA = false, heldA = false, releaseA;
const assets = new Set(['index.html', 'app.js', 'styles.css', 'diagram.js', 'diagram.css', 'timeline-ui.js', 'timeline.mjs']);
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, base);
  let value;
  if (u.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') { mutations++; res.writeHead(405); return res.end('{}'); }
    if (u.pathname === '/api/state') value = { runs, booted: true, events: [], rev: 1, maxActiveRuns: 2, archivedRuns: [] };
    else if (u.pathname === '/api/cluster' || u.pathname.endsWith('/cluster')) value = cluster;
    else if (u.pathname.endsWith('/timeline') || u.pathname === '/api/timeline') value = { points, milestones: [] };
    else if (u.pathname === '/api/grafana') {
      const id = u.searchParams.get('run');
      if (delayA && id === ids[0]) { delayA = false; heldA = true; await new Promise(r => { releaseA = r; }); }
      value = { available: true, baseUrl: base, dashboardUrl: base + '/d/scaling-lab',
        runUrl: base + '/d/scaling-lab?var-run=' + id,
        embedUrl: base + '/d-solo/scaling-lab?var-run=' + id + '&panelId=7' };
    } else value = runs.find(r => u.pathname === '/api/runs/' + r.id) || {};
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(value));
  }
  if (u.pathname.startsWith('/d-solo/')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<html><body style="background:#f5f7ef;font-family:system-ui;padding:20px"><h2>Grafana panel fixture</h2><p>HTTP 200 · 9 / HTTP 500 · 1</p><p>Run: ' + u.searchParams.get('var-run') + '</p></body></html>');
  }
  const file = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
  if (!assets.has(file)) { res.writeHead(404); return res.end(); }
  const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'text/javascript';
  res.writeHead(200, { 'content-type': type });
  res.end(await readFile(resolve('dashboard', file)));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
base = 'http://127.0.0.1:' + server.address().port;
await mkdir('results', { recursive: true });
const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [], checks = [];
page.on('pageerror', e => errors.push(e.message));
function check(label, pass) { checks.push({ label, pass }); console.log((pass ? 'PASS ' : 'FAIL ') + label); if (!pass) throw new Error(label); }
try {
  await page.route('https://fonts.googleapis.com/**', r => r.abort());
  await page.goto(base);
  await page.click('.lesson-link[data-index="6"]');
  await page.waitForFunction(() => window.labRun != null);
  await page.selectOption('#run-select', ids[0]);
  await page.waitForFunction(id => window.labRun === id, ids[0]);
  await page.waitForFunction(id => document.querySelector('#grafana-open').href.includes(id), ids[0]);
  const normal = (await page.locator('#observe').boundingBox()).width;
  await page.click('#timeline-pause');
  const cursor = await page.evaluate(() => window.labCursor);
  await page.click('#observe-toggle');
  const expanded = (await page.locator('#observe').boundingBox()).width;
  check('expanded panel provides materially more width', expanded > normal * 1.5);
  check('accessible expanded state', await page.getAttribute('#observe-toggle', 'aria-expanded') === 'true');
  check('selected run and pause survive expansion', await page.evaluate(id => window.labRun === id && document.querySelector('#live-pill').textContent === 'PAUSED', ids[0]));
  const src = await page.getAttribute('#grafana-embed', 'src');
  check('Grafana panel uses selected run', new URL(src).searchParams.get('var-run') === ids[0]);
  check('paused Grafana uses absolute time', /^\d+$/.test(new URL(src).searchParams.get('to')));
  await page.waitForTimeout(2100);
  check('normal polls do not reload paused iframe', await page.getAttribute('#grafana-embed', 'src') === src);
  await page.screenshot({ path: 'results/ui-observation-expanded.png', fullPage: true });
  await page.keyboard.press('Escape');
  check('Escape restores normal layout', await page.getAttribute('#observe-toggle', 'aria-expanded') === 'false');
  check('collapse preserves cursor and pause', await page.evaluate(c => window.labCursor === c && document.querySelector('#live-pill').textContent === 'PAUSED', cursor));
  await page.click('#timeline-pause');
  await page.click('#observe-toggle');
  delayA = true;
  for (let i = 0; i < 70 && !heldA; i++) await page.waitForTimeout(100);
  check('test actually holds an old monitoring response', heldA);
  await page.selectOption('#run-select', ids[1]);
  releaseA();
  await page.waitForFunction(id => document.querySelector('#grafana-open').href.includes(id) && window.labRun === id, ids[1]);
  await page.waitForTimeout(2000);
  check('late monitoring response cannot restore old run', new URL(await page.getAttribute('#grafana-embed', 'src')).searchParams.get('var-run') === ids[1]);
  await page.setViewportSize({ width: 390, height: 844 });
  check('mobile page has no horizontal clipping', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  check('layout actions issue no cluster mutation requests', mutations === 0);
  check('browser has no JavaScript errors', errors.length === 0);
} finally {
  await browser.close();
  await new Promise(r => server.close(r));
  await writeFile('results/ui-observation-checks.json', JSON.stringify({ checks, errors, mutations }, null, 2));
}
