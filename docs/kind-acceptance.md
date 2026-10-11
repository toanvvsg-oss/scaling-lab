# Kind regression and acceptance

Unit checks run on every PR/push. The fresh-kind workflow also runs the full live matrix for changes to app/dashboard/manifests/scripts/Makefile and can be started manually from GitHub Actions. It uploads evidence and failure logs.

## Automatic fresh-cluster commands

```sh
make test-kind-smoke
make test-kind
node scripts/kind-cleanup-check.mjs
```

The harness generates its own unique scaling-lab-test-* name, private kubeconfig and free ports. It exercises production Make startup, Grafana provisioning/PromQL, real HTTP status metrics, run creation/archive/cleanup and A/B isolation. Full mode additionally installs KEDA and metrics-server and runs all seven actual verifiers, with both graceful and abrupt shutdown. Failed/inconclusive results exit nonzero. Finally it kills its process-owned dashboard/forwards, deletes only its own cluster, removes private temp files and checks that preexisting cluster names remain. Signal/failure cleanup has a separate real-cluster test. Evidence stays in results/scaling-lab-test-*/summary.json. SIGKILL/host power loss cannot run a process cleanup handler; GitHub-hosted runners are discarded after the job.

Requirements: Docker, kind, kubectl, Helm, make and Node.js 22+. Default three nodes match production; KIND_TEST_WORKERS=0 uses one node on a laptop with existing clusters. Allow 10–25 minutes for full mode and image downloads; the harness has a 30-minute deadline. No existing learner cluster/run is reused or deleted. Kubernetes commands pin kind-scaling-lab inside the PRIVATE config that points only at the generated test cluster. Normal commands keep using the real dedicated kind-scaling-lab context.

The scripts below are additional manual acceptance on an existing learning cluster.

## Fast path (~5 min)

```sh
rtk npm test
rtk proxy make check
rtk proxy make verify SCENARIO=connections
```

## Full matrix (~30 min)

Each command writes JSON evidence under `results/` (git-ignored). Save the
`results/<scenario>-*.json` paths for the review.

```sh
for s in connections timeouts rollout streaming; do
  rtk proxy make verify SCENARIO=$s
done
rtk proxy make verify SCENARIO=shutdown MODE=graceful
rtk proxy make verify SCENARIO=shutdown MODE=abrupt
rtk proxy make prometheus-up
rtk proxy make verify SCENARIO=prometheus
rtk proxy make hpa-up
rtk proxy make verify SCENARIO=autoscale
```

## Dashboard acceptance

```sh
rtk proxy make dashboard   # http://127.0.0.1:4173, separate terminal
```

Exercise in the browser: stepper on every lesson, prediction gating
(reveal refused before observation), manual steady/ramp/burst with a
duration, pause/scrub/replay, run switching, cleanup cancel/confirm, evidence
download (including an archived run after cleanup). Watch the browser console
for JS errors. Capture screenshots for `docs/dashboard.png` and the review.

Reusable scripted acceptance (needs Google Chrome plus
`npm install --no-save playwright-core` once; needs one free run slot):

```sh
node scripts/ui-accept.mjs
node scripts/ui-race.mjs
node scripts/ui-history.mjs
node scripts/ui-observation.mjs
```

Every check asserts and the script exits nonzero on any FAIL. Screenshots and
downloaded evidence land in `results/`.

`ui-history.mjs` requires a Ready Prometheus run and uses controlled browser
responses to check historical pod/endpoint snapshots, request trace filtering,
rate headlines, and resume. It does not mutate the cluster. `ui-race.mjs`
requires one free run slot and a retained Prometheus run; it deletes only its
own temporary run. Both exit nonzero when an assertion fails.

## Run isolation checks (API)

```sh
A=$(curl -s -X POST http://127.0.0.1:4173/api/runs -H 'content-type: application/json' -d '{"lesson":"prometheus"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
B=$(curl -s -X POST http://127.0.0.1:4173/api/runs -H 'content-type: application/json' -d '{"lesson":"prometheus"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -s -X POST http://127.0.0.1:4173/api/runs/$A/load -H 'content-type: application/json' -d '{"action":"start","profile":"burst"}'
# compare /api/runs/$A/timeline vs /api/runs/$B/timeline, then:
curl -s -X POST http://127.0.0.1:4173/api/runs/$A/load -H 'content-type: application/json' -d '{"action":"stop"}'
curl -s "http://127.0.0.1:4173/api/evidence?run=$A" -o results/accept-$A.json
curl -s -X DELETE http://127.0.0.1:4173/api/runs/$B
curl -s "http://127.0.0.1:4173/api/evidence?run=$B" -o results/accept-$B.json
```

Clean up only your own acceptance runs; never delete another learner's
retained runs or any other kind cluster to free slots.
