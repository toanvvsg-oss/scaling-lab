import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runScenario } from './runner.mjs';

const id = process.argv[2] || 'connections';
const mode = process.argv[3] || 'graceful';
const allowed = new Set(['connections', 'timeouts', 'shutdown', 'rollout', 'streaming', 'autoscale', 'prometheus']);
if (!allowed.has(id)) { console.error(`Unknown scenario: ${id}`); process.exit(2); }
const events = [];
const report = { scenario: id, mode, started: new Date().toISOString(), events };
try {
  report.result = await runScenario(id, { mode }, (type, data) => {
    events.push({ at: new Date().toISOString(), type, data });
    if (type === 'note' || type === 'pod-delete' || type === 'slow-end' || type === 'stream-end') console.log(`${type}: ${data.text || data.pod || data.error || ''}`);
  });
  report.finished = new Date().toISOString();
  console.log(`Result: ${report.result.status}`);
  for (const check of report.result.checks) console.log(`${check.pass ? '✓' : '✕'} ${check.label}`);
} catch (error) {
  report.error = error.message;
  console.error(`Scenario error: ${error.message}`);
}
const directory = resolve(process.env.SCALING_LAB_RESULTS_DIR || 'results');
await mkdir(directory, { recursive: true });
const filename = `${id}-${Date.now()}.json`;
await writeFile(resolve(directory, filename), JSON.stringify(report, null, 2));
console.log(`Evidence: results/${filename}`);
if (report.error || report.result?.status !== 'pass') process.exitCode = 1;
