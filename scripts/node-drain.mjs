// Guarded node-drain exercise (lesson 14 CLI continuation).
// A real drain is node-wide mutation: this script confines it with explicit
// confirmation, worker-only targeting, a bounded timeout, guaranteed
// uncordon (including on failure and SIGINT), and a JSON evidence file.
// It NEVER touches other clusters: every kubectl call pins --context
// kind-scaling-lab, and only the named node is cordoned/drained/uncordoned.
//
// Usage:
//   SCALING_LAB_DRAIN_CONFIRM=<node> node scripts/node-drain.mjs --node <node> [--timeout-secs 120]
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CTX = 'kind-scaling-lab';

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { node: null, timeoutSecs: 120 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--node') out.node = argv[++i];
    else if (argv[i] === '--timeout-secs') out.timeoutSecs = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}. Usage: --node <name> [--timeout-secs 120]`);
  }
  if (!out.node) throw new Error('Missing --node <name>. Drain targets one explicit node only.');
  if (!Number.isFinite(out.timeoutSecs) || out.timeoutSecs < 30 || out.timeoutSecs > 300) {
    throw new Error('--timeout-secs must be within 30..300.');
  }
  return out;
}

export function checkConfirm(node, env = process.env) {
  if (env.SCALING_LAB_DRAIN_CONFIRM !== node) {
    throw new Error(`Refusing drain of ${node}: set SCALING_LAB_DRAIN_CONFIRM=${node} to confirm this exact node.`);
  }
}

export function runKubectl(args, { stdin = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', ['--context', CTX, ...args], { timeout: 300000 });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`kubectl ${args.slice(0, 3).join(' ')} failed: ${err.trim().slice(0, 300) || `exit ${code}`}`))));
    if (stdin != null) { child.stdin.write(stdin); child.stdin.end(); }
  });
}

export async function inspectNode(node, exec = runKubectl) {
  const raw = await exec(['get', 'node', node, '-o', 'json']);
  const obj = JSON.parse(raw);
  const labels = obj.metadata?.labels || {};
  const ready = (obj.status?.conditions || []).find((c) => c.type === 'Ready')?.status === 'True';
  return {
    name: node,
    ready,
    // Presence, not truthiness: the control-plane label commonly carries an
    // empty value, and Boolean('') would wrongly admit the node.
    controlPlane: 'node-role.kubernetes.io/control-plane' in labels,
    unschedulable: Boolean(obj.spec?.unschedulable),
  };
}

export async function drainNode({ node, timeoutSecs, exec = runKubectl, resultsDir = null, confirmEnv = process.env }) {
  checkConfirm(node, confirmEnv);
  const info = await inspectNode(node, exec);
  if (!info.ready) throw new Error(`Refusing drain: node ${node} is not Ready.`);
  if (info.controlPlane) throw new Error(`Refusing drain: node ${node} is a control-plane node (workers only).`);
  const dir = resultsDir || join(dirname(fileURLToPath(import.meta.url)), '..', 'results');
  const evidence = { node, startedAt: new Date().toISOString(), timeoutSecs, uncordoned: false, outcome: null, error: null };
  let uncordon = async () => {
    try {
      await exec(['uncordon', node]);
      evidence.uncordoned = true;
    } catch (error) {
      evidence.uncordonError = error.message;
    }
  };
  const onSigint = () => { void uncordon().finally(() => process.exit(130)); };
  process.on('SIGINT', onSigint);
  try {
    await exec(['cordon', node]);
    await exec(['drain', node, '--ignore-daemonsets', '--delete-emptydir-data', `--timeout=${timeoutSecs}s`]);
    evidence.outcome = 'drained';
  } catch (error) {
    evidence.outcome = 'failed';
    evidence.error = error.message;
    throw error;
  } finally {
    await uncordon();
    process.removeListener('SIGINT', onSigint);
    evidence.finishedAt = new Date().toISOString();
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `drain-${node}-${Date.now()}.json`), JSON.stringify(evidence, null, 2));
    } catch { /* evidence write is best effort; uncordon already done */ }
  }
  return evidence;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url).endsWith(process.argv[1].split('/').pop()) && process.argv[1].includes('node-drain');
if (isMain) {
  try {
    const { node, timeoutSecs } = parseArgs();
    const evidence = await drainNode({ node, timeoutSecs });
    console.log(JSON.stringify({ node, outcome: evidence.outcome, uncordoned: evidence.uncordoned }));
    if (evidence.outcome !== 'drained') process.exitCode = 1;
  } catch (error) {
    console.error(`node-drain: ${error.message}`);
    process.exitCode = 2;
  }
}
