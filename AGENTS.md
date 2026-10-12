# Project instructions

This repository is a hands-on kind lab for Node.js connection reuse, graceful shutdown, Kubernetes rollouts, and CPU/Prometheus autoscaling, organized as a narrative learning path (see `README.md` and `docs/scaling-mastery-plan.md`).

## Read first

- Read `README.md` for setup, the single-lesson lifecycle, and lesson behavior.
- For lifecycle design, follow `docs/adr-single-lesson.md` (one active lesson; supersedes multi-run UX). For namespace isolation mechanics, see `docs/adr-run-isolation.md`.
- `docs/scaling-mastery-plan.md` is the accepted curriculum/upgrade brief. `docs/opencode-handoff.md` is obsolete and does not override it.

## Cluster safety

- Use only Kubernetes context `kind-scaling-lab`. Pass `--context kind-scaling-lab` explicitly to `kubectl`; do not rely on the current context.
- Lab work happens in two places: the shared `scaling-lab` namespace (Prometheus, Grafana, edge legacy path, CLI verifiers) and the single active lesson namespace `scaling-run-<id>` (labelled run/lesson/owner). Never touch namespaces outside these two shapes.
- Other kind clusters may exist on the machine. Never delete or change them. `make down` deletes the dedicated `scaling-lab` cluster, so use it only when teardown is intended.
- Narrow authorized exceptions on kind-scaling-lab only: (1) installing lab infrastructure (metrics-server in kube-system, KEDA in keda, Prometheus/Grafana/kube-state-metrics in scaling-lab) via the Makefile setup targets; (2) the explicit guarded node-drain CLI exercise (`scripts/node-drain.mjs`, worker nodes only, exact-name confirmation, guaranteed uncordon). Neither authorizes unrelated workload edits or other clusters.
- Do not expose arbitrary shell or `kubectl` execution through the dashboard HTTP API. Keep dashboard actions restricted to known lab operations with validated run IDs (`^[a-z0-9]{8}$`) and the single-allocation lesson endpoints.

## Commands and verification

- `make up` creates or updates the base lab (also rebuilds + reloads the app image — re-run it after changing `app/`); `make prometheus-up` installs Prometheus and KEDA; `make hpa-up` activates CPU scaling; `make dashboard` serves the UI on `127.0.0.1:4173`.
- Console builds: `dashboard/dist/` is gitignored, so run `make ui-build` (installs `dashboard/ui` deps and builds) after a fresh clone or UI source change; `make ui-dev` serves from source with hot reload. The console at `/` is React + Tailwind; `/worksheet` keeps its classic page. Lesson selection is by stable lesson ID (sidebar chapters); displayed numbers derive from the catalog order.
- Single-lesson lifecycle: Preview (no provisioning) → explicit Start lesson (staged: prerequisites → environment → readiness) → Practice (exactly one active environment, server-enforced across tabs) → End lesson (cancels work, saves evidence, deletes only the owned namespace) → read-only History. Switching lessons asks first; cancel leaves everything untouched. See `docs/adr-single-lesson.md`.
- `npm test` runs unit tests (CI runs it on every PR). `make verify SCENARIO=<id>` runs live checks and writes evidence under `results/` (`downstream` is dashboard-only: it needs the provisioned `dep` workload). See `docs/kind-acceptance.md` for the full live matrix.
- After changing a lab scenario, run focused unit tests and the relevant live verifier against kind. For UI changes, also test the interaction in a browser and update `docs/dashboard-single-lesson.png` if its overview becomes stale.
- Report the exact commands run, pass/fail results, and any limits of verification. Do not claim a live lab passes based only on mocked data.
