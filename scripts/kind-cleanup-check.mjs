import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

// These are real owned clusters, not mocked teardown assertions. Each case
// intentionally exits nonzero, then verifies that its own summary proves
// removal while all preexisting clusters were preserved.
for (const variant of ['failure', 'SIGTERM']) {
  const child = spawn(process.execPath, ['scripts/kind-test.mjs', '--smoke',
    variant === 'failure' ? '--fail-after-create' : '--hold-after-create'], {
    env: { ...process.env, KIND_TEST_WORKERS: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '', sent = false;
  child.stdout.on('data', c => {
    text += c; process.stdout.write(c);
    if (variant === 'SIGTERM' && !sent && text.includes('HOLD_AFTER_CREATE')) {
      sent = true; child.kill('SIGTERM');
    }
  });
  child.stderr.on('data', c => { text += c; process.stderr.write(c); });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve);
  });
  const path = /Evidence: ([^\n]+\/summary\.json)/.exec(text)?.[1];
  if (!path) throw new Error(variant + ': missing cleanup evidence');
  const report = JSON.parse(await readFile(path.trim(), 'utf8'));
  if (code === 0 || report.cleanup.clusterDeleted !== true || report.cleanup.originalClustersPreserved !== true || report.cleanup.error) {
    throw new Error(variant + ': cleanup contract failed: ' + JSON.stringify(report));
  }
  if (variant === 'SIGTERM' && (code !== 143 || report.signal !== 'SIGTERM')) throw new Error('SIGTERM was not handled');
  if (variant === 'failure' && !report.error.includes('Intentional failure')) throw new Error('Unexpected failure reason');
  console.log('PASS real ' + variant + ' teardown: ' + report.name);
}
