// Local validation for GKE continuation artifacts (no cloud, no kubectl).
// - Parses every k8s/gke/*.yaml document and asserts the expected kinds and
//   the unfilled <GKE_*> placeholders (cloud execution stays pending until a
//   human fills them with explicit project inputs).
// - Asserts scripts/gke-require.mjs refuses to run without ALL of
//   GKE_PROJECT, GKE_REGION, GKE_CLUSTER, GKE_CONTEXT (never defaults).
// Run: node scripts/gke-validate.mjs
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'k8s', 'gke');

function docs(text) {
  return text.split(/^---$/m).map((d) => d.trim()).filter(Boolean);
}

function kindOf(doc) {
  const m = doc.match(/^kind:\s*(\S+)/m);
  return m ? m[1] : null;
}

const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail && !cond ? ` — ${detail}` : ''}`);
  if (!cond) failures.push(name);
};

const files = (await readdir(dir)).filter((f) => f.endsWith('.yaml')).sort();
check('gke yaml artifacts present', files.length >= 3, files.join(','));

const kinds = [];
for (const f of files) {
  const text = await readFile(join(dir, f), 'utf8');
  for (const d of docs(text)) {
    if (/^#/.test(d) && !/^apiVersion/m.test(d)) continue;
    const k = kindOf(d);
    if (k) kinds.push(`${f}:${k}`);
  }
}
for (const want of ['gateway.yaml:Gateway', 'gateway.yaml:HTTPRoute', 'gateway.yaml:HealthCheckPolicy', 'gateway.yaml:GCPBackendPolicy', 'impossible-pending.yaml:Deployment', 'vpa-recommender.yaml:VerticalPodAutoscaler']) {
  check(`artifact contains ${want}`, kinds.includes(want), kinds.join(', '));
}

const gateway = await readFile(join(dir, 'gateway.yaml'), 'utf8');
check('gateway keeps explicit placeholders', /<GKE_PROJECT>/.test(gateway) && /<GKE_REGION>/.test(gateway), 'placeholders must survive until a human configures them');
check('health check targets readiness, not /', /requestPath: \/health\/ready/.test(gateway));
check('no concrete project/zone baked in', !/my-project|example-project|us-central1|europe-west1|[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/.test(gateway.replace(/<GKE_[A-Z]+>/g, '')), 'concrete defaults forbidden');

const guard = await readFile(join(root, 'scripts', 'gke-require.mjs'), 'utf8');
for (const v of ['GKE_PROJECT', 'GKE_REGION', 'GKE_CLUSTER', 'GKE_CONTEXT']) {
  check(`require-guard mentions ${v}`, guard.includes(v));
}

const nodepool = await readFile(join(dir, 'nodepool-gcloud.sh'), 'utf8');
check('nodepool script uses :? guards, never bare defaults', nodepool.includes(':?explicit'));

console.log(failures.length ? `FAILED (${failures.length})` : 'ALL GKE ARTIFACT CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
