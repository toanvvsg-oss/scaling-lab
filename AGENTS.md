# Project instructions

This repository is a hands-on kind lab for Node.js connection reuse, graceful shutdown, Kubernetes rollouts, and CPU/Prometheus autoscaling.

## Read first

- Read `README.md` for setup and lesson behavior.
- For the current interactive-lab work, follow `docs/opencode-handoff.md`, including its live acceptance checklist.

## Cluster safety

- Use only Kubernetes context `kind-scaling-lab`. Pass `--context kind-scaling-lab` explicitly to `kubectl`; do not rely on the current context.
- Lab work happens in two places: the shared `scaling-lab` namespace (Prometheus, Grafana, edge legacy path, CLI verifiers) and isolated run namespaces `scaling-run-<id>` (one per dashboard experiment, labelled run/lesson/owner). Never touch namespaces outside these two shapes.
- Other kind clusters may exist on the machine. Never delete or change them. `make down` deletes the dedicated `scaling-lab` cluster, so use it only when teardown is intended.
- Clean up only your own acceptance runs (`DELETE /api/runs/<id>` or `kubectl delete ns scaling-run-<id>`); never delete another learner's retained runs to free slots.
- Do not expose arbitrary shell or `kubectl` execution through the dashboard HTTP API. Keep dashboard actions restricted to known lab operations with validated run IDs (`^[a-z0-9]{8}$`).

## Commands and verification

- `make up` creates or updates the base lab; `make prometheus-up` installs Prometheus and KEDA; `make hpa-up` activates CPU scaling; `make dashboard` serves the UI on `127.0.0.1:4173`.
- Console builds: `dashboard/dist/` is gitignored, so run `make ui-build` (installs `dashboard/ui` deps and builds) after a fresh clone or UI source change; `make ui-dev` serves from source with hot reload. The console at `/` is React + Tailwind; `/worksheet` keeps its classic page.
- Console monitoring: `GET /api/grafana?run=<id>` is a managed local-only forward to the provisioned Grafana service (ephemeral localhost port, run-validated, never a generic proxy) embedding selectable light-theme panes (in-flight requests: 11, HTTP-code counters: 15, response rate: 7 of **Scaling Lab · HTTP and pod lifecycle**, anonymous Viewer; shutdown/streaming default to in-flight requests). `make grafana-up` restarts Grafana so dashboard edits apply. App `/metrics` exposes `responses_total` (method/route/status/class), a latency histogram, and inflight/open-socket gauges with zero baselines.
- `npm test` runs unit tests (CI runs it on every PR). `make verify SCENARIO=prometheus` and `make verify SCENARIO=autoscale` run live checks and write evidence under `results/`. See `docs/kind-acceptance.md` for the full live matrix.
- Dashboard flows: every lesson runs inside an isolated `scaling-run-<id>` namespace created from the UI (`POST /api/runs` returns the allocated ID; max 7 active). Run switching, cleanup (with archived evidence), and stepper/prediction/timeline flows are per run. `docs/opencode-handoff.md` is the original checklist and is superseded by `docs/adr-run-isolation.md` for run behavior.
- After changing a lab scenario, run focused unit tests and the relevant live verifier against kind. For UI changes, also test the interaction in a browser and update `docs/dashboard.png` if its overview becomes stale.
- Report the exact commands run, pass/fail results, and any limits of verification. Do not claim a live lab passes based only on mocked data.
