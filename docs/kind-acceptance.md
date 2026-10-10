# Kind acceptance (manual / opt-in)

CI runs unit tests only (`npm test` + `git diff --check` on every PR via
`.github/workflows/pr-checks.yml`). Live kind acceptance needs a local
machine with Docker, kind, kubectl, helm, and Node 22+, so it stays manual.
Run everything against context `kind-scaling-lab` only.

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
