import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runScenario } from './runner.mjs';

const id = process.argv[2] || 'connections';
const mode = process.argv[3] || 'graceful';
const allowed = new Set(['connections', 'timeouts', 'shutdown', 'rollout', 'streaming', 'autoscale', 'prometheus', 'capacity', 'hpareact', 'pending', 'resources', 'signals', 'downstream', 'disruptions', 'gateway', 'capstone']);
if (!allowed.has(id)) { console.error(`Unknown scenario: ${id}`); process.exit(2); }
const events = [];
const report = { scenario: id, mode, started: new Date().toISOString(), events };
try {
  const options = id === 'capstone' ? {
    rationale: process.env.SCALING_LAB_CAPSTONE_RATIONALE || 'CLI baseline: two warm replicas, at most five replicas, and a 60% CPU target for the local objective.',
  } : undefined;
  report.result = await runScenario(id, { mode, options }, (type, data) => {
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
const directory = resolve('results');
await mkdir(directory, { recursive: true });
const filename = `${id}-${Date.now()}.json`;
await writeFile(resolve(directory, filename), JSON.stringify(report, null, 2));
console.log(`Evidence: results/${filename}`);
const failed = Boolean(report.error || report.result?.status !== 'pass');
// Explicit exit: keepalive agents can retain refused-connection socket
// handles (a Node userland quirk: agent.destroy() does not reap sockets that
// errored before connect). Evidence is flushed above, so exiting here loses
// nothing; the long-lived dashboard server is unaffected.
process.exit(failed ? 1 : 0);
