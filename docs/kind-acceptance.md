# Kind acceptance (manual / opt-in)

CI runs unit tests only (`npm test` + `git diff --check` on every PR via
`.github/workflows/pr-checks.yml`). Live kind acceptance needs a local
machine with Docker, kind, kubectl, helm, and Node 22+, so it stays manual.
Run everything against context `kind-scaling-lab` only. The dashboard runs
one lesson at a time (server-enforced); the CLI matrix below runs
serialized, one scenario at a time.

## Fast path (~5 min)

```sh
rtk npm test
rtk proxy make check
rtk proxy make verify SCENARIO=connections
```

## Full CLI matrix (~45 min, serialized)

Each command writes JSON evidence under `results/` (git-ignored). Save the
`results/<scenario>-*.json` paths for the review. The `pending` scenario
re-applies the pre-existing shared scaler itself; `resources` does the same
for resources and the CPU HPA.

```sh
for s in connections timeouts rollout streaming; do
  rtk proxy make verify SCENARIO=$s
done
rtk proxy make verify SCENARIO=shutdown MODE=graceful
rtk proxy make verify SCENARIO=shutdown MODE=abrupt
rtk proxy make verify SCENARIO=capacity
rtk proxy make verify SCENARIO=pending
rtk proxy make verify SCENARIO=signals
rtk proxy make verify SCENARIO=hpareact
rtk proxy make verify SCENARIO=gateway
rtk proxy make verify SCENARIO=disruptions
rtk proxy make verify SCENARIO=resources
rtk proxy make prometheus-up
rtk proxy make verify SCENARIO=prometheus
rtk proxy make hpa-up
rtk proxy make verify SCENARIO=autoscale
rtk proxy make verify SCENARIO=capstone
```

`downstream` is dashboard-only: it needs the `dep` workload that only a
lesson Start provisions. Verify it through the dashboard flow below
(Start → Run + verify → End) and keep the evidence download.

## Dashboard acceptance (single-lesson flow)

```sh
rtk proxy make dashboard   # http://127.0.0.1:4173, separate terminal
```

Exercise in the browser, in narrative chapter order: every lesson shows a
preview with **no provisioning**; **Start lesson** walks through
prerequisites → environment → readiness; **Run + verify** (plus guided
actions and manual traffic where offered) drives the practice; **End
lesson** stops traffic, saves evidence, and removes only the owned
namespace. While a lesson is active, starting another returns 409;
selecting another lesson offers Switch (confirm ends the current one and
opens the destination preview without auto-start; cancel leaves everything
untouched). Ending during a scenario, traffic, or a guided stream must
cancel safely and archive an honest cancelled/incomplete outcome — never a
pass, never a stuck 409. History stays readable and downloadable after
teardown and restart. Watch the browser console for JS errors. Capture
screenshots for `docs/dashboard-single-lesson.png` and the review.

Reusable scripted acceptance (needs Google Chrome plus
`npm install --no-save playwright-core` once):

```sh
node scripts/ui-accept.mjs
node scripts/ui-race.mjs
node scripts/ui-history.mjs
```

Every check asserts and the script exits nonzero on any FAIL. Screenshots and
downloaded evidence land in `results/`.

`ui-accept.mjs` drives the React console: chapters render by stable lesson
ID (never by index), preview provisions nothing, Start reaches Ready,
duplicate Start 409s, a connections practice runs guided actions plus the
verifier, switch-cancel preserves the environment, switch-confirm ends and
opens a preview without auto-start, End frees the slot with archived
history, and a spot-check starts/ends two more lessons. It cleans up only
the environments it creates.

`ui-race.mjs` opens two tabs and starts two lessons concurrently: exactly
one Start returns 202 and the other 409, and the loser provisions nothing.
It ends the winner afterwards and never touches retained history.

`ui-history.mjs` reloads mid-practice (lesson selection persists by ID and
the practice reconnects without duplicating the environment), downloads
evidence, ends the lesson, reloads again, and asserts the history entry and
its evidence survive. It creates and ends only its own lesson.

## Lesson isolation checks (API, single slot)

```sh
curl -s -X POST http://127.0.0.1:4173/api/lesson/start -H 'content-type: application/json' -d '{"lesson":"capacity"}'
# second start while active:
curl -s -X POST http://127.0.0.1:4173/api/lesson/start -H 'content-type: application/json' -d '{"lesson":"rollout"}'
# practice via the active run id from GET /api/lesson, then:
curl -s -X POST http://127.0.0.1:4173/api/lesson/end
```

The second start must 409 without provisioning. End must free the slot with
an archived history entry. Clean up only your own acceptance lesson; never
delete retained history or any other kind cluster to free slots.

## Guarded node drain (lesson 14 CLI continuation, opt-in)

```sh
SCALING_LAB_DRAIN_CONFIRM=<worker-node> node scripts/node-drain.mjs --node <worker-node>
```

Worker nodes only (control-plane refused), exact-name confirmation
required, uncordon guaranteed on success, failure, and SIGINT, evidence
written to `results/drain-<node>-*.json`. Run only on a calm cluster; the
dashboard eviction exercises cover the same concepts without node mutation.
