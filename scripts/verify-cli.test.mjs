import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('documented capstone CLI supplies validated baseline options without cluster work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capstone-cli-'));
  const runner = new URL('../dashboard/runner.mjs', import.meta.url).href;
  const verify = new URL('../dashboard/verify.mjs', import.meta.url).pathname;
  const loader = join(directory, 'loader.mjs');
  // Replace only the workload runner; exercise the real option validation and
  // CLI evidence writer. The subprocess never provisions or mutates a cluster.
  const source = `import { validateCapstoneOptions } from ${JSON.stringify(`${runner}?validation`)};
    export async function runScenario(id, input) {
      if (id !== 'capstone') throw new Error('Wrong scenario');
      const options = validateCapstoneOptions(input.options);
      return { status: 'pass', checks: [], evidence: { simulated: true, options } };
    }`;
  await writeFile(loader, `export async function load(url, context, next) {
    if (url === ${JSON.stringify(runner)}) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(source)} };
    return next(url, context);
  }`);
  await promisify(execFile)(process.execPath, ['--loader', loader, verify, 'capstone'], {
    cwd: directory, env: { ...process.env, SCALING_LAB_CAPSTONE_RATIONALE: '' },
  });
  const names = await readdir(join(directory, 'results'));
  const report = JSON.parse(await readFile(join(directory, 'results', names[0]), 'utf8'));
  assert.equal(report.result.evidence.options.minReplicas, 2);
  assert.equal(report.result.evidence.options.maxReplicas, 5);
  assert.match(report.result.evidence.options.rationale, /CLI baseline/);
});
