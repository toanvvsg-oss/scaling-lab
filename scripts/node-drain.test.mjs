import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, checkConfirm, inspectNode, drainNode } from './node-drain.mjs';

test('drain refuses without exact confirmation and control-plane targets', () => {
  assert.throws(() => parseArgs([]), /Missing --node/);
  assert.throws(() => parseArgs(['--node', 'x', '--timeout-secs', '5']), /30\.\.300/);
  assert.throws(() => checkConfirm('n1', {}), /SCALING_LAB_DRAIN_CONFIRM=n1/);
  assert.doesNotThrow(() => checkConfirm('n1', { SCALING_LAB_DRAIN_CONFIRM: 'n1' }));
});

test('drain cords, drains, and always uncordons — including on failure', async () => {
  const calls = [];
  const worker = JSON.stringify({ metadata: { labels: {} }, spec: {}, status: { conditions: [{ type: 'Ready', status: 'True' }] } });
  const exec = async (args) => { calls.push(args.join(' ')); if (args[0] === 'get') return worker; return 'ok'; };
  const ev = await drainNode({ node: 'w1', timeoutSecs: 60, exec, resultsDir: '/tmp', confirmEnv: { SCALING_LAB_DRAIN_CONFIRM: 'w1' } });
  assert.equal(ev.outcome, 'drained');
  assert.equal(ev.uncordoned, true);
  assert.ok(calls.some((c) => c.startsWith('cordon w1')));
  assert.ok(calls.some((c) => c.startsWith('drain w1') && c.includes('--timeout=60s')));

  const calls2 = [];
  const fail = async (args) => { calls2.push(args.join(' ')); if (args[0] === 'get') return worker; if (args[0] === 'drain') throw new Error('eviction blocked'); return 'ok'; };
  await assert.rejects(drainNode({ node: 'w1', timeoutSecs: 60, exec: fail, resultsDir: '/tmp', confirmEnv: { SCALING_LAB_DRAIN_CONFIRM: 'w1' } }), /eviction blocked/);
  assert.ok(calls2.some((c) => c.startsWith('uncordon w1')), 'uncordon runs even when drain fails');

  const cp = JSON.stringify({ metadata: { labels: { 'node-role.kubernetes.io/control-plane': '' } }, spec: {}, status: { conditions: [{ type: 'Ready', status: 'True' }] } });
  await assert.rejects(drainNode({ node: 'cp', timeoutSecs: 60, exec: async (a) => (a[0] === 'get' ? cp : 'ok'), resultsDir: '/tmp', confirmEnv: { SCALING_LAB_DRAIN_CONFIRM: 'cp' } }), /control-plane/);
  const info = await inspectNode('w1', exec);
  assert.equal(info.controlPlane, false);
  assert.equal(info.ready, true);
});
