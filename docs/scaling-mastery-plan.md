# Scaling mastery: Kubernetes first, then GKE

Requested on 2026-10-11. This is the agreed curriculum expansion and implementation brief for OpenCode (Muse Spark 1.3), with Codex reviewing before committing.

## Learning goal

Explain and demonstrate why requests can remain slow while an autoscaler adds pods. Choose capacity and scaling settings from measured latency/error objectives, diagnose delays and bottlenecks, and preserve availability through bursts, rollouts, and node disruptions.

Keep the existing lesson content, evidence retention, CLI verifiers, and predict → act → observe → explain flow. Use isolated namespaces internally, with the single-active-lesson lifecycle below replacing the old multi-run learner experience. Add runnable local experiments rather than lesson cards containing only prose. GKE exercises need explicit cloud configuration and must be clearly distinguished from locally verified experiments.

## Single active lesson (user refinement, 2026-10-12; supersedes multi-run UI)

The user wants a familiar learning-platform flow, without managing seven simultaneous lab environments. This requirement supersedes earlier instructions to retain the active-run limit, multi-run creation UI and All runs panel. Namespace isolation remains an internal implementation detail for safe setup and teardown.

- **Preview:** opening a lesson shows its story, objective, prerequisites, expected duration and Start lesson prompt/button. Reading or selecting a lesson must not provision resources.
- **Start:** explicit Start lesson prepares the full required local environment and reports understandable stages (checking prerequisites, preparing environment, waiting for readiness). Reuse healthy shared infrastructure; install missing known lab dependencies through narrow allowlisted operations with explicit context and server-owned arguments. Never expose general shell execution/manifests through the API. Missing host tools or daemon should produce actionable setup guidance. Normal lesson start must not recreate/delete a cluster. GKE cloud steps still require explicit project/context and are not automatically provisioned by the local Start action.
- **Practice:** exactly one active learner environment is allowed across browser tabs/requests, enforced by the server, including creating, running, stopping and failed-cleanup states. Provide clear status and End lesson. Remove the New run/All runs/concurrent-environment management from the ordinary flow. Maintain the lesson's predict/act/observe/explain/verify controls and evidence.
- **Switch:** selecting another lesson with an allocated environment prompts to end the current lesson, naming the affected lesson and explaining that traffic stops, results are saved and its environment is removed. Cancel stays in the current lesson with traffic/resources untouched. Confirm saves a pending destination, ends the current lesson, then opens the target preview with Start lesson. It must not silently allocate the next lesson on navigation.
- **End:** stop load and cancel/drain guided requests and in-progress scenarios safely, await their cleanup, persist evidence, then delete only the owned lesson namespace. Show progress. A cleanup failure retains the allocation, exposes retry and prevents a second start; do not navigate as if cleanup succeeded. Capture incomplete/cancelled outcomes honestly, never fabricate a pass.
- **History:** completed/ended lessons retain readable results and downloadable evidence after teardown and dashboard restart. Viewing history must not provision an environment. Refresh reconnects to an existing lesson rather than creating duplicates; keep stable lesson IDs through catalog reordering.
- **Migration:** do not silently delete preexisting learner namespaces. If older versions left multiple runs, detect and explain them with a one-time explicit resume/cleanup choice, preserve evidence, and bring the normal flow to one active lesson. Cleanup is limited to verified owned resources. This migration UI should not burden normal new sessions.
- **Validation:** exercise Start to Ready, duplicate/concurrent starts, refresh, cancel switch during traffic, confirmed switch during a scenario, end during a guided stream, failed cleanup/retry, retained history after restart, and all new lesson prerequisites. Test the current React UI and server behavior against real kind where applicable. Update AGENTS.md/ADR/README/acceptance scripts and screenshot to describe this replacement lifecycle and preserve the narrow cluster-safety boundaries.

## Narrative learning order (user refinement, 2026-10-12)

Arrange the curriculum from fundamentals to advanced topics as an engineering story. The numbering in the implementation sections below identifies additions, not the final UI order. Use stable lesson IDs and group the sidebar into these chapters; derive displayed numbering from the ordered catalog.

1. **Follow one request:** Connection reuse → Idle timeouts. Understand the client, proxy, service and app hops before discussing replica counts.
2. **Find one pod's limits:** Measure one pod's capacity → Requests, limits, and throttling. Turn a latency/error objective into measured capacity and explain its resource constraints.
3. **Respond to growing demand:** CPU autoscaling → Prometheus request-rate scaling → Choose a scaling signal → HPA decisions and reaction time. Start with a visible scaling response, then investigate whether the signal and response speed fit the workload.
4. **Explain why extra pods are not enough:** Pending pods and node capacity → Scale into a downstream bottleneck. Diagnose both missing infrastructure capacity and a shared dependency that replicas cannot fix.
5. **Keep serving while the system changes:** Graceful shutdown (including the abrupt failure comparison) → Streaming drain → Rolling deployment → Disruptions under load. Reuse the capacity/headroom lessons to explain safe replacement, eviction and recovery.
6. **Take the system to GKE:** GKE load balancer lifecycle → Capstone. Connect pod and node behavior to real cloud backends, then defend an objective through burst, rollout and disruption.

For each lesson, show a short prerequisite, a question motivated by the previous lesson, the experiment and expected evidence, a takeaway, and a bridge to the next lesson. Teach the prerequisite in the content; do not merely reorder navigation. Mark GKE cloud steps that require explicit configuration clearly. Keep existing stable lesson IDs, saved evidence access and deep links working after reordering, with Start/End lifecycle as specified above. Tests and UI selection must use stable IDs rather than hard-coded lesson indices. Update README, walkthrough, browser checks and overview screenshot to reflect the narrative.

## Lessons to add

### 08 — Measure one pod's capacity

- Disable autoscaling and run one app pod. Offer increasing traffic independently of response completion, within explicit laptop bounds. Record offered, started, dropped/skipped, completed, failed and timed-out work so generator saturation cannot masquerade as service capacity.
- Compare cheap requests with configurable, bounded expensive work. Plot successful RPS/goodput, p50/p95/p99 latency, errors, CPU and in-flight work using bounded histories and actual source timestamps.
- State a latency/error objective before running. Identify the highest measured rate that meets it, with headroom and measurement limitations. Do not label the existing 5 RPS/pod teaching threshold as production capacity.
- Acceptance: real run evidence ties every capacity claim to traffic, latency, errors, configuration, duration, and sample count. Insufficient evidence is inconclusive.

### 09 — Requests, limits, and throttling

- Hold offered traffic constant while varying CPU requests, then CPU limits. Show the HPA utilization denominator and scheduling implications separately from observed throttling.
- Include a bounded memory pressure/OOM demonstration with restart and termination-reason evidence; avoid stressing unrelated workloads.
- Explain why increasing requests can change HPA decisions without changing incoming work. Introduce VPA recommendations and interactions with HPA; check current GKE guidance rather than asserting a timeless incompatibility.
- Acceptance: before/after settings, resource observations and restart/throttling evidence are recorded; do not infer throttling solely from a low CPU limit.

### 10 — HPA decisions and reaction time

- Extend the existing CPU/Prometheus timeline with a prediction of desired replicas, the basic HPA ratio formula, and explanations for differences caused by tolerance, missing metrics, readiness, bounds, rate policies and stabilization.
- Add bounded slow startup, brief burst, unavailable metric and stabilization experiments. Record offered load → observed metric → desired replicas → scheduling → readiness → useful service.
- Acceptance: live evidence demonstrates delay and recovery; predictions are explicitly approximations when controller inputs are unavailable. Never replace missing metrics with zero or conflate KEDA polling with HPA reconciliation.

### 11 — Choose a scaling signal

- Compare CPU, RPS and in-flight work against CPU-heavy and slow I/O workloads. Explain that equal RPS can represent different work costs.
- Add a bounded queue-worker exercise showing backlog, oldest-message age, arrival/service rate and workers. Use real work and observable queue state; label a simulator as a simulator if used, rather than presenting it as Kubernetes scaling.
- Explain backlog drain-time objectives, retries/idempotency and why a signal should respond to useful added capacity.
- Acceptance: learner can run comparisons, see per-run metrics and explain a case in which CPU is a poor signal. A queue scaler must actually change worker capacity to claim autoscaling.

### 12 — Scale into a downstream bottleneck

- Add an isolated dependency with fixed concurrency and bounded work. Increase app replicas and connection pools, and observe throughput, dependency saturation, queueing and tail latency.
- Compare unrestricted-within-lab-bounds retries with bounded retry budgets/backoff, concurrency limits and early load shedding. Never create unbounded retries or queues.
- Acceptance: demonstrate a bottleneck with evidence and show whether mitigation improves timely successful work. Record rejected traffic separately from successful latency so fast failures cannot make the graph look healthy.

### 13 — Pending pods and node capacity

- On kind, create a run-scoped scheduling constraint/resource demand that causes app pods to remain Pending without exhausting or mutating unrelated workloads. Show scheduler reasons and distinguish desired, scheduled, Running and Ready replicas.
- Explain requests, allocatable resources, placement constraints, fragmentation, headroom, image/startup delay and why HPA alone cannot add nodes.
- Provide the GKE Standard continuation: autoscaling node pools, a schedulable scale-up, an impossible constraint, limits/quota failures and autoscaler event diagnosis.
- Acceptance: real Pending evidence locally, bounded cleanup, and clear labeling that kind did not autoscale its nodes. GKE steps capture actual node scale events when run on GKE.

### 14 — Disruptions under load

- Compare rollout, direct pod deletion and eviction with different PodDisruptionBudgets. Explain which operations honor PDBs, placement/topology spread and spare capacity.
- Provide a deliberate node-drain exercise with a maintenance guard. Node-wide mutation must never silently affect other learner runs. Prefer run-scoped eviction demonstrations in the dashboard; a real drain can be an explicit guarded CLI exercise on the dedicated lab cluster.
- Always restore any node scheduling state changed by an exercise, including after failure/interruption. Preserve failure evidence.
- Acceptance: prove allowed/blocked evictions and continued traffic where expected. Do not claim PDBs protect direct deletion, rollouts or involuntary node loss.

### 15 — GKE load balancer lifecycle

- Supply a runnable, documented GKE Gateway or Ingress exercise with app/service/health checks, NEGs, readiness and backend drain configuration appropriate to the chosen API.
- Repeat shutdown, streaming and rollout under traffic; correlate pod lifecycle, backend health, NEG removal, connection draining and client 502/503 observations.
- Explain Standard first for explicit node experiments, then compare selected workloads on Autopilot. Include requests/VPA/cost considerations and teardown.
- Require explicit project, region/zone, cluster/context and resource names. Never use a current/default cloud context implicitly. This task does not provide a cloud project: prepare and validate artifacts locally, and report cloud execution as pending configuration. Do not provision paid cloud resources without a specified target.

## Capstone

Choose a stated latency/error objective and traffic mix. Meet it through a burst, rollout and a guarded disruption; explain time to usable capacity, warm headroom, maximum replicas and cost tradeoffs. Export a report with raw evidence, pass/fail/inconclusive criteria and limitations. Replica growth alone is not a pass.

## Reading path

1. [Using load shedding to avoid overload — AWS Builders' Library](https://aws.amazon.com/builders-library/using-load-shedding-to-avoid-overload/): reproduce overload and goodput curves; explain retry amplification and the interaction between shedding and autoscaling signals.
2. [Handling Overload — Google SRE](https://sre.google/sre-book/handling-overload/): queueing, admission control and work arriving while capacity starts.
3. [Addressing Cascading Failures — Google SRE](https://sre.google/sre-book/addressing-cascading-failures/): build and interrupt a failure feedback loop.
4. [Kubernetes requests and limits — Google Cloud Blog](https://cloud.google.com/blog/products/containers-kubernetes/kubernetes-best-practices-resource-requests-and-limits): resource sizing, scheduling and runtime behavior.
5. [Horizontal Pod Autoscaling — Kubernetes](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/): ratio calculation, missing metrics, readiness, multiple metrics and stabilization.
6. [Demand-based scale-down — Google Cloud Blog](https://cloud.google.com/blog/products/containers-kubernetes/demand-based-scale-down-for-kubernetes-cost-optimization): connect workload sizing to node removal and cost.
7. [About GKE cluster autoscaling](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/cluster-autoscaler): scheduling-driven node decisions and limits.
8. [Kubernetes disruptions](https://kubernetes.io/docs/concepts/workloads/pods/disruptions/): PDB and eviction semantics.
9. [Troubleshoot GKE load balancing](https://docs.cloud.google.com/kubernetes-engine/docs/troubleshooting/load-balancing): NEG removal, draining and 502/503 failures.
10. [GKE autoscaling guide](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/cluster-autoscaler) and [VPA concepts](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/verticalpodautoscaler): platform continuation and current compatibility guidance.

Attach the relevant readings and a concrete reflection question to each lesson. Start implementation with capacity, HPA reaction time and Pending pods, then complete the remaining curriculum.

## Upgrade kind and Kubernetes

- Baseline observed: kind v0.23.0; three scaling-lab nodes at Kubernetes v1.30.0. Another cluster, argocd-rollouts-lab, exists and must remain untouched.
- Official latest stable release checked on 2026-10-11 through GitHub Releases/API: [kind v0.33.0](https://github.com/kubernetes-sigs/kind/releases/tag/v0.33.0), default Kubernetes v1.37.0, image `kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5`. Recheck if executing later; pin the verified stable image and CLI version reproducibly.
- Upgrade both the actual CLI used by setup and the actual scaling-lab cluster, not only documentation. Use official artifacts and verify checksums. Respect kubectl version skew and monitoring/KEDA compatibility; update affected pinned dependencies as needed and document sources.
- kind cluster replacement is authorized by the user's upgrade request. Before replacement, inventory namespaces/runs, preserve saved evidence and export lab manifests/logs needed for recovery. At initial preflight there were no live dashboard-owned run namespaces. Recheck immediately before replacement; preserve any subsequently created learner runs and coordinate rather than deleting them silently.
- Recreate only scaling-lab, reinstall its existing app/metrics/Prometheus/KEDA/Grafana stack, and verify three Ready nodes at the pinned version, readiness, real CPU/custom metrics and existing lessons.
- This upgrade authorizes necessary installation of lab infrastructure in kube-system/keda and its associated cluster-scoped resources on kind-scaling-lab only. It does not authorize unrelated namespace/workload edits or changes to other clusters. Document this narrow setup exception in project instructions if needed.
- Keep local saved evidence outside cluster storage. Do not indiscriminately remove Docker images, volumes or other clusters. Never make a normal make up implicitly delete an existing cluster.

## Implementation and review contract

- Read AGENTS.md, README.md, docs/adr-run-isolation.md and docs/kind-acceptance.md. This plan supersedes obsolete scope in docs/opencode-handoff.md and ignored historical review files.
- Prefix shell commands with rtk; use rtk proxy where needed. Pin all Kubernetes operations to kind-scaling-lab unless using a separately documented GKE command with explicit required context.
- Keep actions allowlisted, validate input bounds server-side, preserve namespace isolation and enforce the single-active-lesson lifecycle above. No arbitrary shell/manifests through HTTP. Serialize start, disruptive actions, cancellation and cleanup; stop background work reliably.
- Implement on the current task branch. OpenCode must not commit, merge or push; Codex reviews and owns the final commit. Do not change global Git/agent settings or switch away from Muse Spark 1.3.
- Run meaningful unit/regression tests, UI build and real browser interactions; run live verifiers for changed and existing scenarios on upgraded kind. Preserve exact commands, outcomes, evidence paths and limitations. No fake live success, diluted assertions or silent retries that erase failures.
- Refresh README, acceptance instructions and dashboard screenshot where stale. The GKE section must distinguish artifact validation from actual cloud execution.
- Deliver a concise summary of changes, test/live evidence, versions and outstanding blockers. Codex will inspect the diff, independently repeat targeted checks, request corrections, and commit only an acceptable result.
