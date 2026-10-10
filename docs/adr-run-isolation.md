# ADR: Run isolation for interactive autoscaling labs

Status: Proposed — awaiting review. Do not treat as accepted until the run-isolation slice is reviewed.

## Problem

All seven lessons share namespace `scaling-lab` and edge endpoint `127.0.0.1:8080`. Switching lessons deletes the active HPA/ScaledObject and restarts `app`/`edge`, so run A cannot survive while the learner experiments with run B. Prometheus queries (`sum(rate(scaling_lab_http_requests_total{job="scaling-app"}[30s]))`) have no run selector, so traffic from one run would move another run's graph and scaler.

## Decision

One Kubernetes namespace per experiment run: `scaling-run-<id>` where `<id>` is 8 lowercase hex chars generated server-side (`crypto.randomBytes(4)`). The namespace carries labels `scaling.lab/run=<id>`, `scaling.lab/lesson=prometheus`, `scaling.lab/owner=dashboard`.

### Shared infrastructure (untouched by runs)

KEDA operator (`keda` namespace), metrics-server (`kube-system`), Prometheus + Grafana + kube-state-metrics (`scaling-lab`), and the dashboard server stay shared. Runs never install or modify them.

### Per-run resources (`scaling-run-<id>` only)

- `Deployment/app` (2 replicas, pod labels `app=scaling-app`, `labrun=<id>`), `Service/app`.
- `ConfigMap/edge-config` + `Deployment/edge` + `Service/edge` (ClusterIP; no NodePort, so no host-port collisions).
- `ScaledObject/app-prometheus` with a run-scoped query:
  `sum(rate(scaling_lab_http_requests_total{job="scaling-app",labrun="<id>"}[30s]))`, threshold `5`, `minReplicaCount: 2`, `maxReplicaCount: 5`.
- KEDA creates `HPA/keda-hpa-app-prometheus` in the run namespace from that ScaledObject.

Every server-side kubectl call pins `--context kind-scaling-lab` and the run namespace. The API accepts only server-generated IDs matching `^[a-z0-9]{8}$`; unknown or malformed IDs get 400/404. No arbitrary manifests, commands, or namespaces pass through HTTP.

### Traffic routing

The dashboard keeps one managed `kubectl port-forward` per active run (`svc/edge` in the run namespace to a server-picked localhost port). Each run owns one `LoadSession` aimed at its forwarded port (`steady`/`ramp`/`burst`, same laptop bounds: 5–40 req/s, 5-minute cap). The legacy fixed edge `127.0.0.1:8080` remains exclusively for the six non-migrated lessons. Stopping a run's load or deleting the run kills its forward and awaits in-flight requests; a browser refresh reconnects to the server-side session.

### Metric labels and timestamps

- `k8s/prometheus.yaml` discovers `scaling-app` pods across **all namespaces** (`kubernetes_sd_configs` has no `namespaces.names` allowlist, which is exact-name only and cannot wildcard) and keeps targets via relabel filtering on `__meta_kubernetes_namespace` (`scaling-lab|scaling-run-[a-z0-9]+`), plus the existing `namespace` label. Prometheus needs a ClusterRole (pods/services/endpoints, get/list/watch) for cross-namespace discovery.
- Run graphs and the KEDA trigger filter by `labrun="<id>"`, so B's traffic never moves A's graph or scaler.
- Timeline points store both the dashboard poll time (`at`) and the Prometheus sample timestamp (`observedAt` from the query result vector). The UI shows the scrape time separately and never presents poll time as scrape time. Missing/stale samples stay `null`/stale, never zero, and break chart lines instead of connecting through gaps.

### Lifecycle and evidence retention

- `POST /api/runs {lesson:"prometheus"}` creates a run: namespace → manifests → wait for exactly 2 Ready non-terminating pods + Ready endpoints → verify Prometheus scrapes ≥2 targets with the run's `labrun` selector → start edge forward. Any step failing aborts creation and removes the namespace, with the exact failing step and recovery action (`make prometheus-up`, targets page).
- `DELETE /api/runs/<id>` snapshots evidence first (run metadata, events, timeline with both timestamps, load totals, verification state), writes `results/archive-<id>.json`, keeps it in memory, then deletes the namespace. `GET /api/evidence?run=<id>` serves the snapshot after cleanup. The UI cleanup dialog names the namespace and effects and offers the download before confirming.
- "Reset" for the Prometheus lesson creates a fresh run instead of mutating the current one.
- Active-run limit is **2** (each run is 2 app pods + 1 edge; suitable for a laptop kind cluster). Creation beyond the limit is rejected with the IDs of active runs to clean up.

## Temporary compatibility limits

- `make verify SCENARIO=prometheus` and `dashboard/runner.mjs:runPrometheusScenario` still use the legacy `scaling-lab` namespace; they are not migrated in this slice.
- CPU and the five connection/shutdown lessons keep the existing `/api/run`, `/api/load`, `/api/reset`, and `127.0.0.1:8080` path unchanged.
- Grafana's provisioned dashboard has no per-run view yet; run comparison happens in the guided UI.
- In-memory run registry resets if the dashboard restarts; archive JSON files under `results/` survive and namespaces can be re-adopted by ID validation only if the dashboard re-discovers them (not implemented — restart requires recreating runs).
