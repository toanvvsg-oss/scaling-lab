import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const RESET_TARGETS = {
  cpu: { lesson: 'autoscale', hpa: 'app', make: 'make hpa-up' },
  prometheus: { lesson: 'prometheus', hpa: 'keda-hpa-app-prometheus', make: 'make prometheus-up' },
  baseline: { lesson: null, hpa: null, make: null },
};

export function validateResetTarget(target) {
  if (!Object.hasOwn(RESET_TARGETS, target)) {
    throw new Error(`Unknown reset target: ${target}. Expected one of cpu, prometheus, baseline.`);
  }
  return target;
}

async function kubectl(...args) {
  const { stdout } = await runFile('kubectl', ['--context', 'kind-scaling-lab', '-n', 'scaling-lab', ...args], { timeout: 180000 });
  return stdout.trim();
}

export async function clusterReadiness() {
  const [podsRaw, slicesRaw, hpaRaw, scaledRaw] = await Promise.all([
    kubectl('get', 'pods', '-l', 'app=scaling-app', '-o', 'json'),
    kubectl('get', 'endpointslices', '-l', 'kubernetes.io/service-name=app', '-o', 'json'),
    kubectl('get', 'hpa', '-o', 'json').catch(() => '{"items":[]}'),
    kubectl('get', 'scaledobject', '-o', 'json').catch(() => '{"items":[]}'),
  ]);
  const pods = JSON.parse(podsRaw).items;
  const readyPods = pods.filter((p) => !p.metadata.deletionTimestamp && p.status.containerStatuses?.every((c) => c.ready));
  const slices = JSON.parse(slicesRaw).items.flatMap((x) => x.endpoints || []);
  const readyEndpoints = slices.filter((e) => e.conditions?.ready && !e.conditions?.terminating);
  const hpas = JSON.parse(hpaRaw).items.filter((x) => x.spec?.scaleTargetRef?.name === 'app');
  const scaled = JSON.parse(scaledRaw).items;
  return { pods, readyPods, slices, readyEndpoints, hpas, scaled };
}

export async function waitForBaseline(timeoutMs = 120000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    last = await clusterReadiness();
    if (last.readyPods.length === 2 && last.pods.length === 2 && last.readyEndpoints.length >= 2) return last;
    await sleep(2000);
  }
  throw new Error(`Reset did not settle to exactly two Ready app pods (saw ${last?.readyPods.length ?? '?'} ready of ${last?.pods.length ?? '?'} pods, ${last?.readyEndpoints.length ?? '?'} ready endpoints).`);
}

export async function runReset(target, emit) {
  validateResetTarget(target);
  const steps = [];
  const record = (id, ok, detail) => {
    steps.push({ id, ok, detail });
    emit('reset', { text: `${id}: ${detail}`, step: id, ok });
  };
  try {
    record('stop-traffic', true, 'Load session stopped by reset; scenario lock held so no new traffic starts.');
    record('remove-competing-scaler', true, 'Removing both HPA app and ScaledObject app-prometheus if present.');
    await kubectl('delete', 'hpa', 'app', '--ignore-not-found');
    await kubectl('delete', 'scaledobject', 'app-prometheus', '--ignore-not-found');
    await kubectl('delete', 'hpa', 'keda-hpa-app-prometheus', '--ignore-not-found').catch(() => {});

    record('restore-baseline', true, 'Restoring app/edge manifests and restarting rollouts.');
    await kubectl('apply', '-f', 'k8s/app.yaml', '-f', 'k8s/proxy.yaml');
    await kubectl('rollout', 'restart', 'deployment/app');
    await kubectl('rollout', 'restart', 'deployment/edge');
    await kubectl('rollout', 'status', 'deployment/app', '--timeout=180s');
    await kubectl('rollout', 'status', 'deployment/edge', '--timeout=180s');

    if (target === 'cpu') {
      record('ensure-scaler', true, 'Applying CPU HPA manifest k8s/hpa.yaml.');
      await kubectl('apply', '-f', 'k8s/hpa.yaml');
    } else if (target === 'prometheus') {
      const prom = await kubectl('get', 'deployment', 'prometheus', '-o', 'name').catch(() => null);
      if (!prom) throw new Error('Prometheus deployment is missing. Run make prometheus-up first.');
      record('ensure-scaler', true, 'Applying KEDA ScaledObject manifest.');
      await kubectl('apply', '-f', 'k8s/prometheus-scaledobject.yaml');
    } else {
      record('ensure-scaler', true, 'Baseline requested: leaving both scalers removed.');
    }

    record('wait-ready', true, 'Waiting for exactly two Ready, non-terminating app pods and Ready endpoints.');
    const state = await waitForBaseline();

    if (target === 'cpu') {
      const cpuHpa = state.hpas.find((h) => h.metadata.name === 'app'
        && (h.spec?.metrics || []).some((m) => m.type === 'Resource' && m.resource?.name === 'cpu'));
      if (!cpuHpa) throw new Error('CPU HPA app with a CPU Resource metric is not active. Run make hpa-up.');
      const competing = state.hpas.filter((h) => h.metadata.name !== 'app');
      if (competing.length) throw new Error(`Competing HPA remains for Deployment/app: ${competing.map((h) => h.metadata.name).join(', ')}`);
    }
    if (target === 'prometheus') {
      const kedaHpa = state.hpas.find((h) => h.metadata.name === 'keda-hpa-app-prometheus'
        && (h.spec?.metrics || []).some((m) => m.type === 'External'));
      if (!kedaHpa) throw new Error('KEDA HPA keda-hpa-app-prometheus with an External metric is not active. Run make prometheus-up.');
      const competing = state.hpas.filter((h) => h.metadata.name !== 'keda-hpa-app-prometheus');
      if (competing.length) throw new Error(`Competing HPA remains for Deployment/app: ${competing.map((h) => h.metadata.name).join(', ')}`);
      const so = state.scaled.find((s) => s.metadata?.name === 'app-prometheus');
      if (!so) throw new Error('ScaledObject app-prometheus is missing. Run make prometheus-up.');
    }
    if (target === 'baseline' && state.hpas.length) {
      throw new Error(`Expected no HPA after baseline reset, found: ${state.hpas.map((h) => h.metadata.name).join(', ')}`);
    }
    record('verify', true, `Settled to ${state.readyPods.length} Ready pods, ${state.readyEndpoints.length} Ready endpoints.`);
    return { ok: true, steps, readyPods: state.readyPods.length, hpas: state.hpas.map((h) => h.metadata.name) };
  } catch (error) {
    record('failed', false, error.message);
    throw error;
  }
}
