# Project instructions

This repository is a hands-on kind lab for Node.js connection reuse, graceful shutdown, Kubernetes rollouts, and CPU/Prometheus autoscaling.

## Read first

- Read `README.md` for setup and lesson behavior.
- For the current interactive-lab work, follow `docs/opencode-handoff.md`, including its live acceptance checklist.

## Cluster safety

- Use only Kubernetes context `kind-scaling-lab` and namespace `scaling-lab` for lab resources. Pass `--context kind-scaling-lab` explicitly to `kubectl`; do not rely on the current context.
- Other kind clusters may exist on the machine. Never delete or change them. `make down` deletes the dedicated `scaling-lab` cluster, so use it only when teardown is intended.
- Do not expose arbitrary shell or `kubectl` execution through the dashboard HTTP API. Keep dashboard actions restricted to known lab operations.

## Commands and verification

- `make up` creates or updates the base lab; `make prometheus-up` installs Prometheus and KEDA; `make hpa-up` activates CPU scaling; `make dashboard` serves the UI on `127.0.0.1:4173`.
- `npm test` runs unit tests. `make verify SCENARIO=prometheus` and `make verify SCENARIO=autoscale` run live checks and write evidence under `results/`.
- After changing a lab scenario, run focused unit tests and the relevant live verifier against kind. For UI changes, also test the interaction in a browser and update `docs/dashboard.png` if its overview becomes stale.
- Report the exact commands run, pass/fail results, and any limits of verification. Do not claim a live lab passes based only on mocked data.
