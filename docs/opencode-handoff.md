# OpenCode handoff: interactive autoscaling labs

This document is the implementation checklist. Work in `/Users/toanvv/labs/scaling-lab`. The learner should be able to create a traffic change, see the metric and Kubernetes response on one timeline, and safely reset before switching lessons. Keep the existing seven lessons and CLI verifier working.

## Current baseline

- Commit `2f034ef` already prevents the CPU lesson from accepting KEDA's HPA and the Prometheus lesson from accepting the CPU HPA. Do not redo this item.
- `make prometheus-up` installs Prometheus and KEDA; `make hpa-up` activates the CPU HPA. `make reset` restores the app baseline. The dashboard currently has `POST /api/run`, live pod/endpoint lists, an event timeline, and a small Prometheus rate chart. It has no UI reset or manual load controls.
- The project has no external database. Runtime dashboard state is in memory; CLI evidence is written under ignored `results/`.

## Work items, in implementation order

### 1. Add safe reset and lesson switching in the UI

- Add a **Reset lesson** action and a confirmation dialog. When switching between CPU and Prometheus lessons, explain that the current autoscaler must be replaced and ask for confirmation *before* changing cluster resources. Simply opening another lesson must not mutate the cluster.
- The dialog must name the affected resources and effects: active traffic stops, the old HPA or ScaledObject is removed, app/edge configuration returns to baseline, and app pods may restart. Offer a way to download the current evidence before reset. Cancel must leave the cluster and running lesson untouched.
- Implement a narrow backend reset/switch endpoint for the dedicated lab context and namespace. Accept only known lesson IDs/actions; do not expose arbitrary `kubectl` or shell commands through HTTP. Serialize reset with scenario execution so a reset cannot race with load generation or a rollout. Show progress and errors in the UI.
- On successful reset, wait for **exactly two Ready, non-terminating app pods**, Ready endpoints, and the intended autoscaler state. When switching to CPU, verify the CPU HPA; when switching to Prometheus, verify the KEDA HPA and Prometheus scrape targets. If setup is missing, show the exact Make target to run.
- Keep **Delete kind cluster** separate from lesson reset, with its own explicit confirmation. Switching lessons must not delete the cluster. Preserve the existing CLI targets.

**Acceptance:** Cancel changes nothing. A confirmed reset stops load, returns to two Ready app pods, and leaves no competing HPA for `Deployment/app`. A failed reset reports which step failed and allows retry.

### 2. Let the learner control request traffic

- In lesson 07, add an automatic walkthrough and a manual mode with `steady`, `ramp`, and `burst` traffic profiles. Provide **Start**, **Increase**, **Decrease**, and **Stop** controls. Show the requested RPS, elapsed time, and current phase. Bound rates/durations to values safe for a laptop kind cluster.
- The backend owns one load session at a time and uses the same lab edge endpoint (`127.0.0.1:8080`). Stopping or resetting must stop creating new requests and await/cancel outstanding work cleanly. A browser refresh must not orphan a load process; the UI must reconnect to the current session state.
- Ask the learner to predict the next metric/replica change before revealing the explanation. Keep the existing one-click scenario and pass/fail verification available.

**Acceptance:** Starting a profile produces measurable HTTP traffic; changing or stopping it changes the offered RPS. A second session is rejected clearly. No traffic remains after Stop or Reset. The existing `make verify SCENARIO=prometheus` still passes.

### 3. Build one synchronized cause-and-effect timeline

- Show these time series on aligned timestamps: **offered RPS**, **Prometheus observed RPS**, **HPA desired replicas**, **actual replicas**, and **Ready replicas**. Mark load changes, HPA decisions, pod creation/readiness/termination, endpoint changes, and request failures. Display units and the 5 requests/second per-pod target clearly.
- Sample or query Prometheus at an appropriate interval and keep timestamps from the source; distinguish a missing/stale sample from zero. Keep a bounded history so the browser and server remain responsive. The existing small rate chart may be replaced by this view.
- Add a hover/click detail for each milestone: what changed, which component observed it, and why the next stage can lag. Allow replay of the completed run at a slower speed while keeping the raw evidence downloadable.
- Reuse the same visual model for CPU scaling where practical, substituting CPU utilization for Prometheus RPS. Do not imply that HPA reacts instantly to a request spike.

**Acceptance:** During a live Prometheus run, a learner can point to the traffic increase, the later Prometheus increase, the later desired replica change, the pod becoming Ready, and the reverse sequence during scale-in. The chart and evidence agree on times and values.

### 4. Grafana as an optional advanced exercise

- Do **not** make Grafana a prerequisite for the guided UI. First finish the built-in timeline above.
- If added, provide an opt-in `make grafana-up` / `make grafana-ui` path with a provisioned Prometheus data source and a small dashboard for request rate, HPA desired/current replicas, Ready pods, and errors. Document how to compare it with the guided UI. Keep Grafana local to the lab and pin its image version.

**Acceptance:** All guided lessons work without Grafana. Optional Grafana startup exposes a useful preconfigured dashboard without manual data-source setup.

## Access the kind cluster and self-verify

The repository's `AGENTS.md` imports `/Users/toanvv/.codex/RTK.md`: prefix shell commands with `rtk`. Use `rtk proxy <command>` for tools without a dedicated RTK wrapper. Work only against **context `kind-scaling-lab`**, **namespace `scaling-lab`**. Another kind cluster may exist on the machine; do not use the current kubectl context implicitly, and do not delete other clusters.

Preflight from the repo root:

```sh
rtk proxy docker info
rtk proxy kind get clusters
rtk proxy kubectl config get-contexts kind-scaling-lab
rtk proxy helm version
rtk npm test
```

If `scaling-lab` is absent, `rtk proxy make up` creates its three-node kind cluster. The app is exposed at `http://127.0.0.1:8080`; the dashboard is `http://127.0.0.1:4173`. Run the dashboard in a separate terminal with `rtk proxy make dashboard`. For Prometheus, `rtk proxy make prometheus-up` builds the app, installs the monitoring stack and scaler. `rtk proxy make prometheus-ui` opens Prometheus at `http://127.0.0.1:19090` in another terminal.

Useful read-only checks:

```sh
rtk proxy kubectl --context kind-scaling-lab -n scaling-lab get deployments,pods,services,hpa,scaledobject
rtk proxy kubectl --context kind-scaling-lab -n scaling-lab get endpointslices -l kubernetes.io/service-name=app
rtk proxy curl -fsS http://127.0.0.1:8080/health/ready
rtk proxy curl -fsS http://127.0.0.1:8080/metrics
rtk proxy curl -fsS http://127.0.0.1:4173/api/cluster
```

Expected Prometheus baseline: two Ready app pods, one Ready edge, one Ready Prometheus, one `app-prometheus` ScaledObject, and one `keda-hpa-app-prometheus` HPA. Its metric type is `External`. The CPU lesson instead requires HPA `app` with a CPU `Resource` metric. Never leave both HPAs managing `Deployment/app`.

Run live acceptance, not only unit tests:

1. `rtk proxy make prometheus-up`; open lesson 07 and confirm the graph starts at two Ready pods. Use manual controls to create a burst, then reduce/stop it. Confirm the graph shows offered RPS, scraped RPS, desired replicas, Ready pods, and scale-in in that order.
2. `rtk proxy make verify SCENARIO=prometheus`. Expect `Result: pass` and five passing checks. Save the `results/prometheus-*.json` path and summarize peak RPS, initial/peak/final pods, and request failures. This can take several minutes due to HPA stabilization.
3. Exercise reset and lesson switching on the UI: cancel once, confirm once, reload the page during a load session, and verify no orphan traffic or competing HPA. Check the cluster with the explicit-context commands above.
4. `rtk proxy make hpa-up`, then `rtk proxy make verify SCENARIO=autoscale`. Confirm the CPU HPA is active and KEDA's ScaledObject is absent. Test the wrong-scaler error in both directions.
5. Run `rtk npm test`, `rtk proxy make check`, and `rtk git diff --check`. Capture a dashboard screenshot if the UI changes and update `docs/dashboard.png` and `README.md`.

The existing `make reset` and `make down` are available for recovery. `make down` deletes **only** the `scaling-lab` kind cluster; use it only when intentional. Do not claim acceptance from a diagram or mocked data alone.

## Deliverable for review

Commit the implementation on a branch and report the commit hash, changed files, test output, live verification evidence path/summary, and any remaining limitations. Keep unrelated lab behavior intact. The reviewer will inspect the diff and repeat targeted checks.
