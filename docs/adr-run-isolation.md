# ADR: Run isolation for interactive autoscaling labs

Status: Reviewed implementation pending final verification — the behaviors below are implemented and live-verified; the reviewer re-runs targeted checks before acceptance.

Extended slice: all seven lessons now run isolated. `dashboard/runner.mjs` threads `namespace`/`endpoint` (defaults preserve the legacy `scaling-lab` + `:8080` CLI path); `POST /api/runs/:id/run` executes any matching scenario inside the run namespace; the UI provisions a fresh run per lesson on Run. Autoscale runs provision a CPU HPA; the other five get app + edge only.

## Problem

All seven lessons share namespace `scaling-lab` and edge endpoint `127.0.0.1:8080`. Switching lessons deletes the active HPA/ScaledObject and restarts `app`/`edge`, so run A cannot survive while the learner experiments with run B. Prometheus queries (`sum(rate(scaling_lab_http_requests_total{job="scaling-app"}[30s]))`) have no run selector, so traffic from one run would move another run's graph and scaler.

## Decision

One Kubernetes namespace per experiment run: `scaling-run-<id>` where `<id>` is 8 lowercase hex chars generated server-side (`crypto.randomBytes(4)`). The namespace carries labels `scaling.lab/run=<id>`, `scaling.lab/lesson=prometheus`, `scaling.lab/owner=dashboard`.

### Shared infrastructure (untouched by runs)

KEDA operator (`keda` namespace), metrics-server (`kube-system`), Prometheus + Grafana + kube-state-metrics (`scaling-lab`), and the dashboard server stay shared. Runs never install or modify them.

### Per-run resources (`scaling-run-<id>` only)

- `Deployment/app` (2 replicas, pod labels `app=scaling-app`, `labrun=<id>`), `Service/app`.
- `ConfigMap/edge-config` + `Deployment/edge` + `Service/edge` (ClusterIP; no NodePort, so no host-port collisions).
- Autoscale lesson: `HPA/app` (CPU Resource target, mirrors `k8s/hpa.yaml`).
- Prometheus lesson: `ScaledObject/app-prometheus` with a run-scoped query:
  `sum(rate(scaling_lab_http_requests_total{job="scaling-app",labrun="<id>"}[30s]))`, threshold `5`, `minReplicaCount: 2`, `maxReplicaCount: 5`.
- KEDA creates `HPA/keda-hpa-app-prometheus` in the run namespace from that ScaledObject.
- The other five lessons get app + edge only and run their scenarios via `POST /api/runs/:id/run`.

Every server-side kubectl call pins `--context kind-scaling-lab` and the run namespace. The API accepts only server-generated IDs matching `^[a-z0-9]{8}$`; unknown or malformed IDs get 400/404. No arbitrary manifests, commands, or namespaces pass through HTTP.

### Traffic routing

The dashboard keeps one managed `kubectl port-forward` per active run (`svc/edge` in the run namespace to a server-picked localhost port). Each run owns one `LoadSession` aimed at its forwarded port: request profiles (`steady`/`ramp`/`burst` with phases) or CPU-work profiles for autoscale runs, with duration controls (30s–5min cap). Stopping a run's load or deleting the run kills its forward and awaits in-flight requests; a browser refresh reconnects to the server-side session (lesson/run selection persists locally). The legacy fixed edge `127.0.0.1:8080` and `/api/run`, `/api/load`, `/api/reset` remain only as a compatibility path for direct API/CLI use; the UI drives all lessons through runs.

### Metric labels and timestamps

- `k8s/prometheus.yaml` discovers `scaling-app` pods across **all namespaces** (`kubernetes_sd_configs` has no `namespaces.names` allowlist, which is exact-name only and cannot wildcard) and keeps targets via relabel filtering on `__meta_kubernetes_namespace` (`scaling-lab|scaling-run-[a-z0-9]+`), plus the existing `namespace` label. Prometheus needs a ClusterRole (pods/services/endpoints, get/list/watch) for cross-namespace discovery.
- Run graphs and the KEDA trigger filter by `labrun="<id>"`, so B's traffic never moves A's graph or scaler.
- Timeline points store the dashboard poll time (`at`), the Prometheus evaluation time (`observedAt`), and — for Prometheus runs — the true stored-sample time (`sampleAt`, from the `timestamp()` vector function) plus raw counter, scrape targets, and the KEDA external current/target quantities (normalized with units; raw strings retained). The UI labels each time separately. Missing/stale/failed scrapes stay `null`/stale, never zero, and break chart lines instead of connecting through gaps. CPU runs show HPA-reported utilization with its target instead.

### Lifecycle and evidence retention

- `POST /api/runs {lesson}` (any of the seven lessons) creates a run: namespace → manifests → wait for exactly 2 Ready non-terminating pods + Ready endpoints → lesson checks (Prometheus scrape targets via the run's `labrun` selector; CPU HPA presence) → start edge forward. The response returns the allocated ID immediately. Any step failing aborts creation and removes the namespace (retaining a `cleanup-failed` record with its slot only if the namespace actually survives rollback), with the exact failing step and recovery action (`make prometheus-up`, targets page).
- `DELETE /api/runs/<id>` rejects synchronously (409) while creation, a scenario, a learner action, or a guided long request is active. Otherwise it stops traffic first, snapshots evidence (run metadata, events, timeline with all timestamps, load totals, verification state), writes and re-reads `results/archive-<id>.json`, keeps it in memory, then deletes the namespace idempotently (`--ignore-not-found`; an already-absent namespace succeeds and frees the slot). `GET /api/evidence?run=<id>` serves live, in-memory, or on-disk snapshots after cleanup.
- "New run" for any lesson creates a fresh run instead of mutating anything; lesson switching never touches another run.
- Active-run limit is **2**, counting every non-terminal run (`ready`, `creating`, `deleting`, `degraded`, `cleanup-failed`) — only `deleted` and confirmed-gone `failed` free a slot. Creation beyond the limit is rejected with the IDs of active runs to clean up.
- Guided learner actions (`POST /api/runs/<id>/actions`) execute one observable step per lesson (connection batches, gap probes, long-request start/terminate, rollout traffic + trigger) with mutual exclusion against scenarios, loads, and cleanup; the preStop lifecycle hook reports through an app-local `/lifecycle` endpoint.
- Guided predictions are scoped per run/lesson with per-lesson explanations; reveal requires experiment activity recorded after the prediction.

## Compatibility and known limits

- `make verify SCENARIO=*` and the legacy `/api/run`, `/api/load`, `/api/reset` paths keep working against the shared `scaling-lab` namespace; the UI drives all lessons through runs.
- Grafana's provisioned dashboard has a `$run` template variable with per-run rate/target/replica panels plus an explicit legacy-lab panel; the guided UI remains fully usable without Grafana.
- Restart limits (live history): a dashboard restart re-adopts strictly-labelled run namespaces (name, owner, known lesson) and rebuilds their traffic routes, and re-discovers on-disk evidence archives — but in-memory run events/timelines and load sessions from before the restart are gone. Only runs recreated or re-adopted after a restart are drivable; archive files remain downloadable.
