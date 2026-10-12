// Explicit-context guard for any GKE continuation command.
// Every entrypoint that touches a cloud cluster imports this first: it
// refuses to run unless ALL of GKE_PROJECT, GKE_REGION, GKE_CLUSTER and
// GKE_CONTEXT are set, and it never falls back to a current/default context.
export function requireGkeEnv(env = process.env) {
  const missing = ['GKE_PROJECT', 'GKE_REGION', 'GKE_CLUSTER', 'GKE_CONTEXT'].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`Refusing GKE action: missing ${missing.join(', ')}. Export explicit values; defaults are never used.`);
  }
  return { project: env.GKE_PROJECT, region: env.GKE_REGION, cluster: env.GKE_CLUSTER, context: env.GKE_CONTEXT };
}
