// In-memory Kubernetes double. No kubectl, no network, no traffic.
export function makeFakeCluster(opts = {}) {
  const namespaces = new Map();
  const applied = [];
  const calls = [];
  const failDelete = new Set(opts.failDelete || []);
  let seq = 0;
  let port = 18080;
  const forwards = [];
  let releaseApply = null;
  let gated = 0;
  const gateApply = opts.gateApply === true;
  const podsJson = JSON.stringify({
    items: [1, 2].map((i) => ({
      metadata: { name: `app-x-${i}`, deletionTimestamp: null },
      status: { phase: 'Running', containerStatuses: [{ ready: true }] },
    })),
  });
  const slicesJson = JSON.stringify({
    items: [{ endpoints: [1, 2].map((i) => ({ targetRef: { name: `app-x-${i}` }, conditions: { ready: true, terminating: false } })) }],
  });
  const deps = {
    genId: () => (0xa0000000 + seq++).toString(16),
    sleep: async () => {},
    query: async () => ({ value: 2, at: new Date().toISOString(), stale: false }),
    apply: async (ns, obj) => {
      if (gateApply && gated++ === 0 && !releaseApply) await new Promise((r) => { releaseApply = r; });
      applied.push([ns, obj.kind, obj.metadata?.name]);
      if (obj.kind === 'Namespace') namespaces.set(obj.metadata.name, { labels: obj.metadata.labels, deployments: {} });
      if (obj.kind === 'Deployment' && ns && namespaces.has(ns)) namespaces.get(ns).deployments[obj.metadata.name] = true;
    },
    exec: async (args) => {
      const a = args.join(' ');
      calls.push(a);
      if (a.includes('rollout status')) return { stdout: 'ok' };
      if (a.includes('get hpa app')) return { stdout: 'hpa/app' };
      if (a.includes('get deployment/app')) return { stdout: 'ok' };
      if (a.includes('delete namespace')) {
        const ns = args[args.indexOf('namespace') + 1];
        if (failDelete.has(ns)) throw new Error('injected delete failure');
        namespaces.delete(ns);
        return { stdout: 'deleted' };
      }
      if (a.includes('get namespaces')) {
        return { stdout: JSON.stringify({ items: [...namespaces.entries()].map(([name, v]) => ({ metadata: { name, labels: v.labels, creationTimestamp: new Date().toISOString() } })) }) };
      }
      {
        const m = /get namespace ([A-Za-z0-9-]+)/.exec(a);
        if (m) {
          if (!namespaces.has(m[1])) throw new Error(`namespaces "${m[1]}" not found`);
          return { stdout: `namespace/${m[1]}` };
        }
      }
      if (a.includes('get pods')) return { stdout: podsJson };
      if (a.includes('get endpointslices')) return { stdout: slicesJson };
      if (a.includes('get hpa')) return { stdout: '{"items":[]}' };
      throw new Error(`fake does not implement: ${a}`);
    },
    forward: async () => {
      const f = { port: port++, closed: false, close() { f.closed = true; } };
      forwards.push(f);
      return f;
    },
  };
  return {
    deps, namespaces, applied, calls, forwards,
    release: () => { if (releaseApply) { const r = releaseApply; releaseApply = null; r(); } },
  };
}
