# GKE continuation (cloud steps stay pending explicit configuration)

No cloud project was provided for this task. Everything under `k8s/gke/` is
**validated locally only** (`node scripts/gke-validate.mjs`): YAML parses,
expected kinds exist, placeholders are still placeholders, and the
explicit-context guard refuses to run without inputs. **Cloud execution is
pending configuration — nothing here has run against GKE.**

To run any step below you must export all four inputs yourself; commands
always pin `--context "${GKE_CONTEXT}"` and never use a current/default
context:

```sh
export GKE_PROJECT=<your-project> GKE_REGION=<your-region> \
       GKE_CLUSTER=<your-cluster> GKE_CONTEXT=<your-context>
node -e "import('./scripts/gke-require.mjs').then(m => { m.requireGkeEnv(); console.log('inputs present'); })"
```

## Lesson 13 — Pending pods and node capacity (GKE Standard first)

1. Create the autoscaling pool (`k8s/gke/nodepool-gcloud.sh` documents the
   exact `gcloud` command with `:?` guards): min 1, max 3, then schedule the
   demo workload and watch a real `TriggeredScaleUp`.
2. Apply the impossible constraint (`k8s/gke/impossible-pending.yaml`) and
   confirm the autoscaler can NOT fix it — contrast with the
   resource-driven scale-up in step 1.
3. Diagnose with autoscaler logs and `NotTriggerScaleUp` / quota events.
4. Delete the pool afterwards (pools bill until deleted).

## Lesson 14 — Disruptions (PDBs travel with you)

The PDB from the local lesson applies unchanged on GKE. Eviction ordering
(`kubectl create --raw .../eviction`) works against any explicit context.
Compare the same workload on **Autopilot** afterwards: node management
disappears, so disruption budgets and spread become the whole story.

## Lesson 09 — Requests, limits, VPA (recommendation first)

Apply `k8s/gke/vpa-recommender.yaml` (mode `Off`) and read recommendations
without moving the HPA denominator. Check current GKE VPA/HPA compatibility
guidance before combining update modes in production:
<https://docs.cloud.google.com/kubernetes-engine/docs/concepts/verticalpodautoscaler>

## Lesson 15 — Load balancer lifecycle (the local analogue, labeled)

The dashboard lesson is a **local backend-drain analogue**: kind has no GKE
Gateway or NEGs, so endpoint-slice removal stands in for NEG removal. The UI
and evidence say so explicitly. For the cloud half:

1. Fill every `<GKE_*>` placeholder in `k8s/gke/gateway.yaml`.
2. Apply Gateway → HTTPRoute → HealthCheckPolicy → GCPBackendPolicy against
   the explicit context; verify backend health before traffic.
3. Repeat shutdown/streaming/rollout under traffic and correlate NEG removal,
   drain timeouts, and client 502/503 — the same three timestamps as the
   local exercise, now from real backends.
4. Tear everything down; compare cost/overhead notes with the Autopilot run.

## Capstone on GKE

Defend the same objective with the GKE backend in front. The report format
(raw evidence, criteria, limitations) is unchanged; add backend health and
drain settings to the limitations section.
