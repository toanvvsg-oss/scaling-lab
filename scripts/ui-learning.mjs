// Browser regression against an in-memory cluster and simulated experiments.
// This script never calls kubectl and is not live-kind acceptance.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createApp } from '../dashboard/server.mjs';
import * as R from '../dashboard/runs.mjs';
import { makeFakeCluster } from '../dashboard/test-fake.mjs';

const directory = await mkdtemp(join(tmpdir(), 'lab-ui-learning-'));
const fake = makeFakeCluster();
let experiments = 0;
function session() {
  return { active: false, state: () => ({ active: false, total: 0 }) };
}
function appFor() {
  return createApp({
    resultsDir: directory, enableSampler: false,
    clusterState: async () => ({ connected: true, pods: [], endpoints: [] }),
    grafanaApi: { status: async () => ({ available: false }), close() {} },
    loadFactory: session,
    runScenario: async () => ({ status: ++experiments === 1 ? 'fail' : 'pass', checks: [], evidence: { simulated: true } }),
    runsApi: {
      ...R,
      beginRun: (lesson, emit) => R.beginRun(lesson, emit, fake.deps),
      finishRun: (run, emit) => R.finishRun(run, emit, fake.deps),
      cleanupRun: (id) => R.cleanupRun(id, directory, fake.deps),
      runClusterState: (id) => R.runClusterState(id, fake.deps),
      adoptOrphanRuns: () => R.adoptOrphanRuns(fake.deps),
      checkLessonPrereqs: async () => ({ ok: true, checks: [{ name: 'simulated cluster', ok: true }], missing: [] }),
    },
  });
}
let app = appFor();
await app.boot();
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const port = app.server.address().port;
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.addInitScript(() => localStorage.setItem('scaling-lab.lesson', 'capacity'));
const api = async (path) => (await fetch(`${base}${path}`)).json();
try {
  await page.goto(base);
  await page.getByRole('button', { name: 'Start lesson →', exact: true }).click();
  await page.getByLabel('Reasoning', { exact: false }).waitFor();
  await page.getByLabel('Reasoning', { exact: false }).fill('first prediction reasoning');
  await page.getByRole('button', { name: 'No — timely goodput flattens', exact: true }).click();
  await page.getByText('Predicted. Observe, then reveal the model explanation.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Run + verify →', exact: true }).click();
  await page.getByText('fail', { exact: true }).first().waitFor();
  await page.getByLabel('Observation', { exact: true }).fill('initial observation');
  await page.getByLabel('Cited evidence (metric, phase, or event)', { exact: true }).fill('initial evidence');
  await page.getByLabel('Interpretation', { exact: true }).fill('initial interpretation');
  await page.getByLabel('Proposed next action', { exact: true }).fill('measure again');
  await page.getByRole('button', { name: 'Submit explanation', exact: true }).click();
  await page.getByRole('button', { name: 'Mark self-review done', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Mark self-review done', exact: true }).click();
  await page.getByText('Self-review recorded. Revising keeps your initial response.', { exact: true }).waitFor();
  await page.reload();
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some((t) => t.value === 'initial observation'));
  assert.equal(await page.getByLabel('Reasoning', { exact: false }).inputValue(), 'first prediction reasoning');
  assert.equal(await page.getByLabel('Observation', { exact: true }).inputValue(), 'initial observation');
  await page.getByLabel('Observation', { exact: true }).fill('unsaved draft');
  await page.waitForTimeout(5500);
  assert.equal(await page.getByLabel('Observation', { exact: true }).inputValue(), 'unsaved draft', 'polling preserves drafts');

  // Restart the actual HTTP app with a fresh registry and the same fake
  // namespaces/disk. This checks the recovery wiring as well as rendering.
  app.server.closeAllConnections();
  await app.close();
  R.runs.clear();
  app = appFor();
  await app.boot();
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  await page.reload();
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some((t) => t.value === 'initial observation'));
  assert.equal(await page.getByLabel('Reasoning', { exact: false }).inputValue(), 'first prediction reasoning');
  await page.getByRole('button', { name: 'Prepare next attempt', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].every((t) => t.value === ''));
  await page.getByLabel('Reasoning', { exact: false }).fill('second prediction reasoning');
  await page.getByRole('button', { name: 'No — timely goodput flattens', exact: true }).click();
  await page.getByText('Predicted. Observe, then reveal the model explanation.', { exact: true }).waitFor();
  const id = (await api('/api/lesson')).active.runId;
  assert.equal((await api(`/api/runs/${id}`)).prediction.prior, true);
  await page.getByRole('button', { name: 'Run + verify →', exact: true }).click();
  await page.getByText('pass', { exact: true }).first().waitFor();
  const evidence = await api(`/api/evidence?run=${id}`);
  assert.equal(evidence.attempts.length, 1);
  assert.equal(evidence.attempts[0].result.status, 'fail');
  assert.equal(evidence.attempts[0].learning.explanation.observation, 'initial observation');
  assert.equal(evidence.result.status, 'pass');
  assert.equal(evidence.learning.explanation, null);
  assert.equal(evidence.learning.selfReview, null);
  await page.getByRole('button', { name: 'End lesson', exact: true }).click();
  await page.getByRole('button', { name: 'Start lesson →', exact: true }).waitFor();
  await page.getByText('Read saved learning', { exact: true }).click();
  await page.getByText(/second prediction reasoning/).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('button', { name: 'Start lesson →', exact: true }).waitFor();
  await page.screenshot({ path: join(directory, 'narrow-history.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`PASS simulated browser: saved fields, polling drafts, restart, distinct attempts, retained failure, read-only History, narrow viewport; artifacts: ${directory}`);
} catch (error) {
  await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true });
  console.error(`Browser failure artifacts: ${directory}; page errors: ${JSON.stringify(errors)}`);
  throw error;
} finally {
  await browser.close();
  app.server.closeAllConnections();
  await app.close();
}
