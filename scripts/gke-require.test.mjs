import test from 'node:test';
import assert from 'node:assert/strict';
import { requireGkeEnv } from './gke-require.mjs';

test('GKE guard refuses missing vars and never defaults', () => {
  assert.throws(() => requireGkeEnv({}), /GKE_PROJECT/);
  assert.throws(() => requireGkeEnv({ GKE_PROJECT: 'p', GKE_REGION: 'r', GKE_CLUSTER: 'c' }), /GKE_CONTEXT/);
  const ok = requireGkeEnv({ GKE_PROJECT: 'p', GKE_REGION: 'r', GKE_CLUSTER: 'c', GKE_CONTEXT: 'x' });
  assert.deepEqual(ok, { project: 'p', region: 'r', cluster: 'c', context: 'x' });
});
